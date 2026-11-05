// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mandate's payout(id) answer, and the leg and request values a payout
// sends. An open payout is a Record and a terminal one a Tombstone at the same
// key, which is what makes a payout ID impossible to use twice, so the shape
// of this answer is the whole state machine as the adapter sees it.

import type { xdr } from '@stellar/stellar-sdk/base';

import { InternalError } from '../errors.js';
import type { AttestationInput, Bytes32, Destination, PayRequest, UnixSeconds } from '../types.js';
import {
  asBytes32,
  asI128,
  asOption,
  asU32,
  asU64,
  asVariant,
  asVec,
  bytes,
  bytes32,
  destination,
  field,
  fieldsOf,
  i128,
  struct,
  u64,
  vec,
} from './scval.js';

const STATUS_PENDING = 1;
const STATUS_APPROVED = 2;
const STATUS_EXECUTED = 3;
const STATUS_REJECTED = 4;
const STATUS_CANCELLED = 5;

export type PayoutView =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'open';
      readonly status: 'pending' | 'approved';
      readonly total: bigint;
      readonly fee: bigint;
      readonly expiresAt: UnixSeconds;
      readonly approvals: number;
    }
  | { readonly kind: 'closed'; readonly status: 'executed' | 'rejected' | 'cancelled' };

const CLOSED: ReadonlyMap<number, 'executed' | 'rejected' | 'cancelled'> = new Map([
  [STATUS_EXECUTED, 'executed'],
  [STATUS_REJECTED, 'rejected'],
  [STATUS_CANCELLED, 'cancelled'],
]);

export function payoutViewOf(value: xdr.ScVal): PayoutView {
  const some = asOption(value);
  if (some === null) return { kind: 'absent' };
  const { name, payload } = asVariant(some);
  const [body] = payload;
  if (body === undefined) throw new InternalError();
  const fields = fieldsOf(body);
  const status = asU32(field(fields, 'status'));
  if (name === 'Tombstone') {
    const closed = CLOSED.get(status);
    if (closed === undefined) throw new InternalError();
    return { kind: 'closed', status: closed };
  }
  if (name !== 'Record' || (status !== STATUS_PENDING && status !== STATUS_APPROVED)) {
    throw new InternalError();
  }
  return {
    kind: 'open',
    status: status === STATUS_PENDING ? 'pending' : 'approved',
    total: asI128(field(fields, 'total')),
    fee: asI128(field(fields, 'fee')),
    expiresAt: asU64(field(fields, 'expires_at')) as UnixSeconds,
    approvals: asVec(field(fields, 'approvals')).length,
  };
}

/** One attestation as the contract takes it, carrying the epoch it was signed under. */
function attestationScVal(a: AttestationInput, policyEpoch: bigint): xdr.ScVal {
  return struct({
    valid_until: u64('attestations.validUntil', a.validUntil),
    policy_epoch: u64('attestations.policyEpoch', policyEpoch),
    signature: bytes('attestations.signature', a.signature),
  });
}

/** A PayoutRequest, with its legs and attestations in index order. */
export function payoutRequestScVal(
  req: PayRequest,
  destinations: ReadonlyMap<string, Destination>,
  policyEpoch: bigint,
): xdr.ScVal {
  const legs = [...req.legs]
    .sort((a, b) => a.index - b.index)
    .map((leg) => {
      const to = destinations.get(leg.recipientMethodId);
      if (to === undefined) throw new InternalError();
      return struct({
        destination: destination('legs.destination', to),
        amount: i128('legs.amount', leg.amount.amount),
      });
    });
  const attestations = [...req.attestations]
    .sort((a, b) => a.legIndex - b.legIndex)
    .map((a) => attestationScVal(a, policyEpoch));
  return struct({
    payout_id: bytes32('payoutId', req.payoutId),
    recipient_ref: bytes32('recipientRef', req.recipientRef),
    total: i128('total', req.total.amount),
    fee: i128('fee', req.fee.amount),
    legs: vec(legs),
    deadline: u64('deadline', req.deadline),
    task_ref: bytes32('taskRef', req.taskRef),
    attestations: vec(attestations),
  });
}

export interface BatchItemResult {
  readonly payoutId: Bytes32;
  /** The mandate's error code; zero when the item was accepted. */
  readonly code: number;
}

export function batchResultsOf(value: xdr.ScVal): readonly BatchItemResult[] {
  return asVec(value).map((item) => {
    const fields = fieldsOf(item);
    return {
      payoutId: asBytes32(field(fields, 'payout_id')),
      code: asU32(field(fields, 'code')),
    };
  });
}
