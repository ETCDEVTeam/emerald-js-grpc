import {credentials, Metadata, ChannelCredentials} from "grpc";
import {AuthMetadata, JwtSignature, TokenSignature} from "./signature";
import {AuthClient} from './wrapped/Auth';
import {AuthRequest, AuthResponse, TempAuth} from "./generated/auth_pb";

const packageJson = require('../package.json');

export enum AuthenticationStatus {
    AUTHENTICATING,
    AUTHENTICATED,
    ERROR
}

export type AuthenticationListener = (status: AuthenticationStatus) => void;

export class CredentialsContext {
    url: string;
    private readonly ca: Buffer;
    private readonly ssl: ChannelCredentials;
    private authentication: EmeraldAuthentication;
    private token?: AuthMetadata;
    private readonly agent: string[];
    private readonly userId: string;
    private listener?: AuthenticationListener;
    private status = AuthenticationStatus.AUTHENTICATING;
    private channelCredentials: ChannelCredentials;

    constructor(url: string, ca: string | Buffer, agent: string[], userId: string) {
        this.url = url;
        if (typeof ca == 'string') {
            this.ca = Buffer.from(ca, 'utf8')
        } else {
            this.ca = ca;
        }
        this.ssl = credentials.createSsl(this.ca);
        this.agent = agent;
        this.userId = userId;

        const ssl = this.getSsl();
        const callCredentials = credentials.createFromMetadataGenerator(
            (params: { service_url: string }, callback: (error: Error | null, metadata?: Metadata) => void) => {
                this.getSigner().then((auth) => {
                    let meta = new Metadata();
                    try {
                        auth.add(meta);
                    } catch (e) {
                        this.notify(AuthenticationStatus.ERROR);
                        callback(e);
                        return
                    }
                    this.notify(AuthenticationStatus.AUTHENTICATED);
                    callback(null, meta);
                }).catch((err) => {
                    this.notify(AuthenticationStatus.ERROR);
                    callback(new Error("Unable to get token"));
                })
            });
        this.channelCredentials = credentials.combineChannelCredentials(ssl, callCredentials)
    }

    protected getSsl(): ChannelCredentials {
        return this.ssl
    }

    protected getSigner(): Promise<AuthMetadata> {
        if (!this.authentication) {
            this.authentication = new JwtUserAuth(this.url, this.getSsl());
        }
        if (typeof this.token == "undefined") {
            return this.authentication.authenticate(this.agent, this.userId)
                .then((token) => {
                    this.token = token;
                    return token;
                });
        }
        return Promise.resolve(this.token);
    }

    public getChannelCredentials(): ChannelCredentials {
        return this.channelCredentials;
    }

    public setListener(listener: AuthenticationListener) {
        this.listener = listener;
        listener(this.status);
    }

    protected notify(status: AuthenticationStatus) {
        if (this.listener && status != this.status) {
            this.listener(status);
            this.status = status;
        }
    }
}

export function emeraldCredentials(url: string, ca: string | Buffer, agent: string[], userId: string): CredentialsContext {
    return new CredentialsContext(url, ca, agent, userId);
}

interface EmeraldAuthentication {
    authenticate(agent: string[], userId: string): Promise<AuthMetadata>
}

class JwtUserAuth implements EmeraldAuthentication {
    client: AuthClient;

    constructor(url: string, cred: ChannelCredentials) {
        this.client = new AuthClient(url, cred);
    }

    authenticate(agent: string[], userId: string): Promise<AuthMetadata> {
        const authRequest = new AuthRequest();
        const tempAuth = new TempAuth();
        tempAuth.setId(userId);
        authRequest.setTempAuth(tempAuth);
        authRequest.setAgentDetailsList(agent);
        authRequest.addAgentDetails(`emerald-client-node/${packageJson.version}`);
        authRequest.setCapabilitiesList(["JWT_RS256", "NONCE_HMAC_SHA256"]);
        authRequest.setScopesList(["BASIC_USER"]);
        return this.client.authenticate(authRequest).then((result: AuthResponse) => {
            if (!result.getSucceed()) {
                throw new Error(`Failed to auth ${result.getDenyCode()}: ${result.getDenyMessage()}`);
            }
            if (result.getType() == "JWT_RS256") {
                return new JwtSignature(result.getToken(), new Date(result.getExpire()));
            } else if (result.getType() == "NONCE_HMAC_SHA256") {
                return new TokenSignature(result.getToken(), result.getSecret());
            } else {
                throw new Error("Unsupported auth: " + result.getType())
            }
        });
    }

}