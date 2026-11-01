// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The network refuses any transaction that runs contract code and carries a
// memo, so a mandate call with one fails every time it is sent. Pooled
// destinations are addressed by the muxed tag on each leg, never a memo.
// The check lives here, with no network access, so the builder, the fee
// bump wrapper, the submit path and the signer can all run the same one.

import { xdr } from '@stellar/stellar-base';

import { MemoOnContractCallError } from '../errors.js';
import type { NetworkId } from '../networks.js';

import { checkNetwork } from './network.js';
import { readXdr } from './xdr.js';

/** The operations that run Soroban host code. */
export const CONTRACT_OPERATION_TYPES = Object.freeze([
  'invokeHostFunction',
  'extendFootprintTtl',
  'restoreFootprint',
] as const);

const CONTRACT_OPERATIONS: ReadonlySet<string> = new Set(CONTRACT_OPERATION_TYPES);

/**
 * A transaction envelope from base64 text, accepted only in its one
 * canonical encoding, so the text that was checked is exactly the text that
 * is signed or sent.
 */
export function readTransactionEnvelope(text: unknown): xdr.TransactionEnvelope {
  return readXdr(text, 'xdr', (input) => xdr.TransactionEnvelope.fromXDR(input, 'base64'));
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
