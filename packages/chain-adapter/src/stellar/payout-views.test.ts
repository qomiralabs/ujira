// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { Keypair, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import { InternalError } from '../errors.js';
import type { Destination, UnixSeconds } from '../types.js';
import { batchResultsOf, payoutRequestScVal, payoutViewOf } from './payout-views.js';
import { asU64, asVec, bytes32, field, fieldsOf, struct, sym, u32, vec } from './scval.js';
import { NETWORK } from './test-adapter.js';
import { METHOD, payRequest, payWorld, record, tombstone } from './test-payouts.js';

describe('reading payout(id)', { timeout: 30_000 }, () => {
  it('reads each shape the mandate answers with', () => {
    expect(payoutViewOf(xdr.ScVal.scvVoid())).toEqual({ kind: 'absent' });
    const approvals = [{ approver: Keypair.random().publicKey(), epoch: 3 }];
    expect(payoutViewOf(record(1, { approvals, fee: 5n, total: 9n, expiresAt: 7n }))).toEqual({
      kind: 'open',
      status: 'pending',
      total: 9n,
      fee: 5n,
      expiresAt: 7n,
      approvals,
    });
    expect(payoutViewOf(record(2))).toMatchObject({ kind: 'open', status: 'approved' });
    expect(payoutViewOf(tombstone(3))).toEqual({ kind: 'closed', status: 'executed' });
    expect(payoutViewOf(tombstone(4))).toEqual({ kind: 'closed', status: 'rejected' });
    expect(payoutViewOf(tombstone(5))).toEqual({ kind: 'closed', status: 'cancelled' });
  });

  it.each<[string, xdr.ScVal]>([
    ['a variant with no body', vec([sym('Record')])],
    ['a tombstone in a live status', vec([sym('Tombstone'), struct({ status: u32('s', 1) })])],
    ['a record in a closed status', vec([sym('Record'), struct({ status: u32('s', 3) })])],
    ['a variant it does not know', vec([sym('Other'), struct({ status: u32('s', 1) })])],
  ])('treats %s as a bug in the answer', (_name, value) => {
    expect(() => payoutViewOf(value)).toThrow(InternalError);
  });
});

describe('building a request', { timeout: 30_000 }, () => {
  const to = new Map<string, Destination>([
    [
      METHOD,
      {
        address: {
          network: NETWORK,
          value: Keypair.random().publicKey(),
        },
        tag: null,
      },
    ],
  ]);

  it('sends attestations in leg order, under the policy epoch they were signed for', () => {
    const w = payWorld();
    const attestation = (legIndex: number, until: bigint) => ({
      legIndex,
      validUntil: until as UnixSeconds,
      signature: new Uint8Array(64),
    });
    const value = payoutRequestScVal(
      payRequest(w, 1, { attestations: [attestation(1, 20n), attestation(0, 10n)] }),
      to,
      3n,
    );
    const list = asVec(field(fieldsOf(value), 'attestations')).map((a) => {
      const fields = fieldsOf(a);
      return [asU64(field(fields, 'valid_until')), asU64(field(fields, 'policy_epoch'))];
    });
    expect(list).toEqual([
      [10n, 3n],
      [20n, 3n],
    ]);
  });

  it('never builds a leg with no destination', () => {
    expect(() => payoutRequestScVal(payRequest(payWorld()), new Map(), 0n)).toThrow(InternalError);
  });
});

describe('reading a batch answer', () => {
  it('keeps each item with its code', () => {
    const id = `0x${'ab'.repeat(32)}` as const;
    const item = struct({
      payout_id: bytes32('id', id as never),
      code: u32('code', 7),
      status: xdr.ScVal.scvVoid(),
    });
    expect(batchResultsOf(vec([item]))).toEqual([{ payoutId: id, code: 7 }]);
  });
});
