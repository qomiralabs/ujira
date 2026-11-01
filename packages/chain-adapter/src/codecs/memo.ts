// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The network refuses any transaction that runs contract code and carries a
// memo, so a mandate call with one fails every time it is sent. Pooled
// destinations are addressed by the muxed tag on each leg, never a memo.
// The check lives here, with no network access, so the builder, the fee
// bump wrapper, the submit path and the signer can all run the same one.

import { xdr } from '@stellar/stellar-base';

import { InvalidInputError, MemoOnContractCallError } from '../errors.js';
import { isNetworkId } from '../networks.js';
import type { NetworkId } from '../networks.js';

/** The operations that run Soroban host code. */
export const CONTRACT_OPERATION_TYPES = Object.freeze([
  'invokeHostFunction',
  'extendFootprintTtl',
  'restoreFootprint',
] as const);

const CONTRACT_OPERATIONS: ReadonlySet<string> = new Set(CONTRACT_OPERATION_TYPES);

// Far above any transaction the network accepts. It only bounds the work
// one call can be made to do before anything is decoded.
const MAX_ENVELOPE_BASE64 = 349_528;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function malformed(): InvalidInputError {
  return new InvalidInputError({ issues: ['xdr (malformed)'] });
}

/** Throws unless `network` is one UJIRA runs on. */
export function checkNetwork(network: unknown): NetworkId {
  if (!isNetworkId(network)) throw new InvalidInputError({ issues: ['network (invalid)'] });
  return network;
}

/**
 * A transaction envelope from base64 text, accepted only in its one
 * canonical encoding, so the text that was checked is exactly the text that
 * is signed or sent.
 */
export function readTransactionEnvelope(text: unknown): xdr.TransactionEnvelope {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_ENVELOPE_BASE64) {
    throw malformed();
  }
  if (!BASE64.test(text)) throw malformed();
  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(text, 'base64');
  } catch {
    // The library's message can quote the input, so only the fact is kept.
    throw malformed();
  }
  if (envelope.toXDR('base64') !== text) throw malformed();
  return envelope;
}

// The transaction whose memo the network reads: a fee bump has no memo of
// its own, so it is the inner one's that counts.
function transactionOf(envelope: xdr.TransactionEnvelope): xdr.Transaction | xdr.TransactionV0 {
  const kind = envelope.switch().name;
  if (kind === 'envelopeTypeTxV0') return envelope.v0().tx();
  if (kind === 'envelopeTypeTxFeeBump') return envelope.feeBump().tx().innerTx().v1().tx();
  return envelope.v1().tx();
}

/** Throws MemoOnContractCallError when the envelope runs contract code and carries any memo. */
export function checkEnvelopeMemo(envelope: xdr.TransactionEnvelope, network: NetworkId): void {
  const tx = transactionOf(envelope);
  if (tx.memo().switch().name === 'memoNone') return;
  if (tx.operations().some((op) => CONTRACT_OPERATIONS.has(op.body().switch().name))) {
    throw new MemoOnContractCallError({ network });
  }
}

/**
 * Checks a transaction or fee bump envelope, as base64 XDR, against the
 * network's rule that a contract call carries no memo. Throws
 * MemoOnContractCallError on a text, id, hash or return memo, and
 * InvalidInputError when the text is not one canonical envelope or the
 * network is unknown. A memo on a transaction that calls no contract is
 * left alone.
 */
export function assertNoMemoOnContractCall(envelopeXdr: string, network: NetworkId): void {
  const checked = checkNetwork(network);
  checkEnvelopeMemo(readTransactionEnvelope(envelopeXdr), checked);
}
