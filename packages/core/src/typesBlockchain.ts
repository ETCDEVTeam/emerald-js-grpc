import * as blockchain_pb from "./generated/blockchain_pb";
import * as common_pb from "./generated/common_pb";
import {DataMapper} from "./Publisher";
import {
    AnyAddress,
    Asset,
    Blockchain,
    isMultiAddress,
    isSingleAddress,
    SingleAddress,
    isXpubAddress,
    asDetailedXpub
} from "./typesCommon";
import {MessageFactory} from "./convert";
import {TextDecoder, TextEncoder} from "text-encoding";

const textDecoder = new TextDecoder("utf-8");
const textEncoder = new TextEncoder();

export type ChainHead = {
    chain: number;
    height: number;
    blockId: string;
    timestamp: Date;
}

export type NativeCallItem = {
    id: number;
    method: string;
    payload: Array<any>
}

export type NativeCallResponse = {
    id: number;
    payload: any;
    success: boolean;
}

export type NativeCallError = {
    id: number;
    success: boolean;
    message: string | undefined;
}

export function isNativeCallResponse(obj: NativeCallResponse | NativeCallError): obj is NativeCallResponse {
    return typeof obj === "object" && obj.success;
}

export function isNativeCallError(obj: NativeCallResponse | NativeCallError): obj is NativeCallError {
    return typeof obj === "object" && !obj.success;
}

export type BalanceRequest = {
    asset: Asset,
    address: AnyAddress,
    includeUtxo?: boolean
}

export interface AddressBalance {
    asset: Asset;
    address: SingleAddress;
    balance: string;
    utxo?: Utxo[] | undefined;
}

export interface Utxo {
    txid: string;
    vout: number;
    value: string;
    spent: boolean;
}

export interface TxStatusRequest {
    blockchain: number;
    txid: string;
    limit: number;
}

export interface TxStatusResponse {
    txid: string;
    broadcast: boolean;
    mined: boolean;
    block?: {
        height: number;
        hash: string;
        timestamp: Date;
        weight: string;
    },
    confirmations: number
}

export class ConvertBlockchain {
    private factory: MessageFactory;

    constructor(factory: MessageFactory) {
        this.factory = factory;
    }

    public chain(blockchain: Blockchain): common_pb.Chain {
        let req: common_pb.Chain = this.factory("common_pb.Chain");
        req.setType(blockchain.valueOf());
        return req
    }

    public headResponse(): DataMapper<blockchain_pb.ChainHead, ChainHead> {
        return (resp: blockchain_pb.ChainHead) => {
            return {
                chain: resp.getChain().valueOf(),
                height: resp.getHeight(),
                blockId: resp.getBlockId(),
                timestamp: new Date(resp.getTimestamp())
            }
        };
    }

    public nativeCallRequest(chain: Blockchain, calls: NativeCallItem[]): blockchain_pb.NativeCallRequest {
        let req: blockchain_pb.NativeCallRequest = this.factory("blockchain_pb.NativeCallRequest");
        req.setChain(chain.valueOf());
        calls.forEach((c) => {
            let call: blockchain_pb.NativeCallItem = this.factory("blockchain_pb.NativeCallItem");
            call.setId(c.id);
            call.setMethod(c.method);
            call.setPayload(new Uint8Array(textEncoder.encode(JSON.stringify(c.payload))));
            req.addItems(call);
        });
        return req
    }

    public nativeCallResponse(): DataMapper<blockchain_pb.NativeCallReplyItem, NativeCallResponse | NativeCallError> {
        return (resp: blockchain_pb.NativeCallReplyItem) => {
            if (resp.getSucceed()) {
                return {
                    id: resp.getId(),
                    success: true,
                    payload: JSON.parse(textDecoder.decode(resp.getPayload_asU8()))
                } as NativeCallResponse
            } else {
                return {
                    id: resp.getId(),
                    success: false,
                    message: resp.getErrormessage()
                } as NativeCallError
            }
        };
    }

    public balanceRequest(req: BalanceRequest): blockchain_pb.BalanceRequest {
        let result: blockchain_pb.BalanceRequest = this.factory("blockchain_pb.BalanceRequest");
        let protoAsset: common_pb.Asset = this.factory("common_pb.Asset");
        protoAsset.setChain(req.asset.blockchain.valueOf());
        protoAsset.setCode(req.asset.code);
        result.setAsset(protoAsset);

        if (typeof req.includeUtxo == "boolean") {
            result.setIncludeUtxo(req.includeUtxo);
        }

        let protoAnyAddress: common_pb.AnyAddress = this.factory("common_pb.AnyAddress");
        if (isSingleAddress(req.address)) {
            let protoSingleAddress: common_pb.SingleAddress = this.factory("common_pb.SingleAddress");
            protoSingleAddress.setAddress(req.address);
            protoAnyAddress.setAddressSingle(protoSingleAddress);
        } else if (isXpubAddress(req.address)) {
            let protoXpubAddress: common_pb.XpubAddress = this.factory("common_pb.XpubAddress");
            let xpub = asDetailedXpub(req.address);
            protoXpubAddress.setXpub(xpub.xpub);
            if (xpub.start) {
                protoXpubAddress.setStart(xpub.start);
            }
            if (typeof xpub.limit === "number") {
                protoXpubAddress.setLimit(xpub.limit);
            } else {
                protoXpubAddress.setLimit(100);
            }
            if (xpub.unused_limit && xpub.unused_limit > 0) {
                protoXpubAddress.setUnusedLimit(xpub.unused_limit)
            }
            protoAnyAddress.setAddressXpub(protoXpubAddress);
        } else if (isMultiAddress(req.address)) {
            let protoMultiAddress: common_pb.MultiAddress = this.factory("common_pb.MultiAddress");
            req.address.forEach((address) => {
                let protoSingleAddress: common_pb.SingleAddress = this.factory("common_pb.SingleAddress");
                protoSingleAddress.setAddress(address);
                protoMultiAddress.addAddresses(protoSingleAddress);
            });
            protoAnyAddress.setAddressMulti(protoMultiAddress);
        }
        result.setAddress(protoAnyAddress);

        return result
    }

    public balanceResponse(): DataMapper<blockchain_pb.AddressBalance, AddressBalance> {
        return (resp: blockchain_pb.AddressBalance) => {
            let asset: Asset = {
                blockchain: resp.getAsset().getChain().valueOf(),
                // @ts-ignore
                code: resp.getAsset().getCode()
            };
            let utxo: Utxo[] | undefined = undefined;
            if (resp.getUtxoList().length > 0) {
                utxo = resp.getUtxoList().map((it) => {
                    return {
                        txid: it.getTxId(),
                        vout: it.getIndex(),
                        value: it.getBalance(),
                        spent: it.getSpent() || false,
                    }
                });
            }
            return {
                asset,
                address: resp.getAddress().getAddress(),
                balance: resp.getBalance(),
                utxo
            }
        }
    }

    public txRequest(req: TxStatusRequest): blockchain_pb.TxStatusRequest {
        let p = this.factory("blockchain_pb.TxStatusRequest");
        p.setChain(req.blockchain);
        p.setTxId(req.txid);
        p.setConfirmationLimit(req.limit < 0 ? 0 : req.limit);
        return p;
    }

    public txResponse(): DataMapper<blockchain_pb.TxStatus, TxStatusResponse> {
        return (resp) => {
            let block;
            if (resp.hasBlock()) {
                const pbBlock = resp.getBlock()!
                block = {
                    height: pbBlock.getHeight(),
                    hash: pbBlock.getBlockId(),
                    timestamp: new Date(pbBlock.getTimestamp()),
                    weight: Buffer.from(pbBlock.getWeight_asU8()).toString('hex')
                }
            } else {
                block = undefined;
            }
            return {
                broadcast: resp.getBroadcasted(),
                confirmations: resp.getConfirmations(),
                mined: resp.getMined(),
                txid: resp.getTxId(),
                block
            }
        }
    }
}