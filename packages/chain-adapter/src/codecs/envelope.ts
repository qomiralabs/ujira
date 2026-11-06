// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Transaction and fee bump envelopes, read into plain data a signer can
// check against its policy before any key is used, and the hash it then
// signs. The hash is computed here from the decoded transaction rather
// than taken from the caller, so what is signed is always what was checked.

import { xdr } from '@stellar/stellar-base';

import type { NetworkId } from '../networks.js';

import { checkNetwork, networkIdOf, sha256 } from './network.js';
import { operationDetail } from './operations.js';
import type { DecodedOperationDetail } from './operations.js';
import { accountOf, bytes, checkSignature, invalid, readXdr } from './xdr.js';
import type { DecodedAccount, Ed25519SignatureParts } from './xdr.js';

/** The most signatures an envelope can carry. */
export const MAX_ENVELOPE_SIGNATURES = 20;

const FIELD = 'xdr';

export interface DecodedOperation {
  /** The operation type as the XDR names it, such as payment or invokeHostFunction. */
  readonly type: string;
  /** The operation's own source, or null when the transaction's applies. */
  readonly source: DecodedAccount | null;
  /** What it does, for the operation types a signer's policy reads. */
  readonly detail: DecodedOperationDetail;
}

export interface DecodedSignature {
  /** The last four bytes of the signing key. */
  readonly hint: Uint8Array;
  readonly signature: Uint8Array;
}

/** Unix seconds. A maxTime of 0 means no upper bound. */
export interface DecodedTimeBounds {
  readonly minTime: bigint;
  readonly maxTime: bigint;
}

export interface DecodedTransaction {
  readonly kind: 'transaction';
  readonly network: NetworkId;
  readonly source: DecodedAccount;
  /** Stroops. */
  readonly fee: bigint;
  readonly sequence: bigint;
  readonly timeBounds: DecodedTimeBounds | null;
  readonly operations: readonly DecodedOperation[];
  /** The Soroban resource fee in stroops, or null for a classic transaction. */
  readonly resourceFee: bigint | null;
  readonly signatures: readonly DecodedSignature[];
  /** The 32 bytes every signer of this transaction signs on this network. */
  readonly hash: Uint8Array;
}

export interface DecodedFeeBump {
  readonly kind: 'fee_bump';
  readonly network: NetworkId;
  /** The account that pays, and signs the outer envelope. */
  readonly feeSource: DecodedAccount;
  /** The most the fee source pays, in stroops. */
  readonly fee: bigint;
  readonly inner: DecodedTransaction;
  readonly signatures: readonly DecodedSignature[];
  /** The 32 bytes the fee source signs on this network. */
  readonly hash: Uint8Array;
}

function readEnvelope(text: unknown): xdr.TransactionEnvelope {
  return readXdr(text, FIELD, (input) => xdr.TransactionEnvelope.fromXDR(input, 'base64'));
}

function signaturesOf(list: readonly xdr.DecoratedSignature[]): readonly DecodedSignature[] {
  return list.map((sig) => ({ hint: bytes(sig.hint()), signature: bytes(sig.signature()) }));
}

function timeBoundsOf(cond: xdr.Preconditions): DecodedTimeBounds | null {
  const name = cond.switch().name;
  // An absent optional reads as undefined, whatever the declarations say,
  // so the value is checked for what it is rather than for null.
  const bounds: unknown =
    name === 'precondTime'
      ? cond.timeBounds()
      : name === 'precondV2'
        ? cond.v2().timeBounds()
        : null;
  if (!(bounds instanceof xdr.TimeBounds)) return null;
  return {
    minTime: BigInt(bounds.minTime().toString()),
    maxTime: BigInt(bounds.maxTime().toString()),
  };
}

function payloadHash(
  network: NetworkId,
  tagged: xdr.TransactionSignaturePayloadTaggedTransaction,
): Uint8Array {
  const payload = new xdr.TransactionSignaturePayload({
    networkId: Buffer.from(networkIdOf(network)),
    taggedTransaction: tagged,
  });
  return sha256(payload.toXDR());
}

function decodeV1(envelope: xdr.TransactionV1Envelope, network: NetworkId): DecodedTransaction {
  const tx = envelope.tx();
  const ext = tx.ext();
  return {
    kind: 'transaction',
    network,
    source: accountOf(tx.sourceAccount()),
    fee: BigInt(tx.fee()),
    sequence: BigInt(tx.seqNum().toString()),
    timeBounds: timeBoundsOf(tx.cond()),
    operations: tx.operations().map((op) => {
      const source = op.sourceAccount();
      return {
        type: op.body().switch().name,
        source: source ? accountOf(source) : null,
        detail: operationDetail(op, FIELD),
      };
    }),
    resourceFee: ext.switch() === 1 ? BigInt(ext.sorobanData().resourceFee().toString()) : null,
    signatures: signaturesOf(envelope.signatures()),
    hash: payloadHash(network, xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTx(tx)),
  };
}

/**
 * A version 1 transaction envelope as plain data, with its hash on
 * `network`. A fee bump or a legacy v0 envelope is refused.
 */
export function decodeTransactionEnvelope(text: string, network: NetworkId): DecodedTransaction {
  const checked = checkNetwork(network);
  const envelope = readEnvelope(text);
  if (envelope.switch().name !== 'envelopeTypeTx') throw invalid(FIELD, 'wrong_envelope_type');
  return decodeV1(envelope.v1(), checked);
}

/**
 * The authorization entries a transaction's one contract call carries, as base64
 * XDR, in order. Empty when it carries none or is not a contract call.
 */
export function invocationAuthEntries(text: string, network: NetworkId): readonly string[] {
  checkNetwork(network);
  const envelope = readEnvelope(text);
  if (envelope.switch().name !== 'envelopeTypeTx') throw invalid(FIELD, 'wrong_envelope_type');
  const [op] = envelope.v1().tx().operations();
  const body = op?.body();
  if (body?.switch().name !== 'invokeHostFunction') return [];
  return body
    .invokeHostFunctionOp()
    .auth()
    .map((entry) => entry.toXDR('base64'));
}

/** A fee bump envelope as plain data, with its hash and its inner transaction's on `network`. */
export function decodeFeeBumpEnvelope(text: string, network: NetworkId): DecodedFeeBump {
  const checked = checkNetwork(network);
  const envelope = readEnvelope(text);
  if (envelope.switch().name !== 'envelopeTypeTxFeeBump') {
    throw invalid(FIELD, 'wrong_envelope_type');
  }
  const outer = envelope.feeBump();
  const tx = outer.tx();
  return {
    kind: 'fee_bump',
    network: checked,
    feeSource: accountOf(tx.feeSource()),
    fee: BigInt(tx.fee().toString()),
    inner: decodeV1(tx.innerTx().v1(), checked),
    signatures: signaturesOf(outer.signatures()),
    hash: payloadHash(
      checked,
      xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTxFeeBump(tx),
    ),
  };
}

/**
 * The envelope with one more signature on it: on the transaction, or on
 * the outer envelope of a fee bump. A signature already there is not added
 * twice, so a retried attach gives the same XDR. The signature is not
 * checked against the hash; the signer does that before it returns one.
 */
export function attachEnvelopeSignature(text: string, parts: Ed25519SignatureParts): string {
  const { publicKey, signature } = checkSignature(parts);
  const envelope = readEnvelope(text);
  const name = envelope.switch().name;
  if (name !== 'envelopeTypeTx' && name !== 'envelopeTypeTxFeeBump') {
    throw invalid(FIELD, 'wrong_envelope_type');
  }
  const holder = name === 'envelopeTypeTx' ? envelope.v1() : envelope.feeBump();
  const hint = publicKey.subarray(publicKey.length - 4);
  const existing = holder.signatures();
  if (existing.some((sig) => sig.hint().equals(hint) && sig.signature().equals(signature))) {
    return text;
  }
  if (existing.length >= MAX_ENVELOPE_SIGNATURES) throw invalid(FIELD, 'too_many_signatures');
  holder.signatures([...existing, new xdr.DecoratedSignature({ hint, signature })]);
  return envelope.toXDR('base64');
}
