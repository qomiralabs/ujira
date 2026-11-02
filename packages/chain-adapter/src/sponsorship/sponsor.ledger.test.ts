// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Runs against the in-memory ledger. The database store runs the same contract
// once its table exists.

import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import { networksConfig } from '../stellar/test-adapter.js';
import { accountFromSeed } from '../testing/address.js';
import {
  createMemorySponsorshipLedger,
  describeSponsorshipLedger,
} from '../testing/sponsorship-ledger.js';
import type { NativeAmount, TenantScope, UnixSeconds, Uuid } from '../types.js';
import { createSponsorshipPolicy } from './policy.js';

const NETWORK = 'stellar:testnet' as const;
const SCOPE: TenantScope = {
  principalId: '00000000-0000-4000-8000-000000000001' as Uuid,
  projectId: '00000000-0000-4000-8000-000000000002' as Uuid,
};
const fee = (amount: bigint): NativeAmount => ({
  network: NETWORK,
  asset: 'XLM',
  amount,
  scale: 7,
});

describeSponsorshipLedger('in memory', () => ({
  ledger: createMemorySponsorshipLedger(),
  network: NETWORK,
  otherNetwork: 'stellar:pubnet',
  scope: SCOPE,
  otherScope: { ...SCOPE, principalId: '00000000-0000-4000-8000-000000000009' as Uuid },
}));

function world() {
  const ledger = createMemorySponsorshipLedger();
  const config = networksConfig({
    sponsor: accountFromSeed(new Uint8Array(32).fill(1)),
    channel: accountFromSeed(new Uint8Array(32).fill(2)),
  });
  const policy = createSponsorshipPolicy({
    ledger,
    config: () => config,
    clock: { nowSeconds: () => 1_800_000_000n as UnixSeconds },
    alerts: { lowBalance: () => undefined },
    sponsorBalance: () => Promise.resolve(10_000_000_000_000n),
  });
  return { ledger, policy };
}

describe('what the policy books', { timeout: 30_000 }, () => {
  it("a request's record rent is booked with its reservation", async () => {
    const { ledger, policy } = world();
    await policy.reserve({
      scope: SCOPE,
      network: NETWORK,
      reservationId: 'request',
      intent: 'admin',
      maxFee: fee(5000n),
    });
    await policy.settle({
      scope: SCOPE,
      reservationId: 'request',
      actualFee: fee(4000n),
      rent: fee(1500n),
    });
    expect(await ledger.get('request')).toMatchObject({
      state: 'settled',
      maxFeeStroops: 5000n,
      actualFeeStroops: 4000n,
      rentStroops: 1500n,
    });
  });

  it('an executor execute is booked with its own intent and actual fee', async () => {
    const { ledger, policy } = world();
    const booking = {
      scope: SCOPE,
      network: NETWORK,
      reservationId: 'executor-hash',
      intent: 'executor',
      actualFee: fee(321n),
      rent: fee(20n),
    } as const;
    await policy.book(booking);
    await policy.book(booking);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      intent: 'executor',
      state: 'settled',
      actualFeeStroops: 321n,
      rentStroops: 20n,
    });
    // All of UJIRA's spend sums from the one table.
    await policy.book({
      ...booking,
      reservationId: 'no-rent',
      actualFee: fee(9n),
      rent: undefined as never,
    });
    expect(await ledger.totals({ network: NETWORK, since: 0n as UnixSeconds })).toEqual({
      count: 2,
      stroops: 330n,
    });
    await expect(
      policy.book({ ...booking, reservationId: 'bad', actualFee: fee(-1n) }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('settles without rent when the transaction paid none', async () => {
    const { ledger, policy } = world();
    await policy.reserve({
      scope: SCOPE,
      network: NETWORK,
      reservationId: 'request',
      intent: 'pause',
      maxFee: fee(500n),
    });
    await policy.settle({ scope: SCOPE, reservationId: 'request', actualFee: fee(400n) });
    expect((await ledger.get('request'))?.rentStroops).toBeNull();
  });
});
