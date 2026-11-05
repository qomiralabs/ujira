// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newTenant, workerHarness, type WorkerHarness } from '../worker/testing/support.js';
import { databasePaidPayout, RequestedNotWholeCentsError } from './paid-payout.js';
import { engineWorld, ONE_USDC, seedTenant, TENANT, usdc } from './testing/world.js';

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
  await seedTenant(harness);
});

afterAll(async () => {
  await harness.close();
});

describe('what a receipt is built from', () => {
  it('is nothing until the payout is paid, and then what was paid', async () => {
    const world = await engineWorld(harness);
    const read = databasePaidPayout(harness.db, world.deps.adapters);
    const payout = await world.payout('paid', usdc(3n * ONE_USDC));
    expect(await read(TENANT, payout.id)).toBeNull();
    await world.drive(payout);
    const paid = await read(TENANT, payout.id);
    expect(paid?.requested).toMatchObject({ amount: 300n, currency: 'USD', scale: 2 });
    expect(paid?.total.amount).toBe(3n * ONE_USDC);
    expect(paid?.fee).toMatchObject({ bps: 100 });
    expect(paid?.legs).toHaveLength(1);
    expect(paid?.legs[0]?.destination.masked).toMatch(/^.{4}\.\.\..{4}$/);
  });

  it('refuses an amount asked for in the token that is not whole cents, rather than round it', async () => {
    const world = await engineWorld(harness);
    const payout = await world.payout('fraction', usdc(3n * ONE_USDC + 1n));
    await world.drive(payout);
    await expect(
      databasePaidPayout(harness.db, world.deps.adapters)(TENANT, payout.id),
    ).rejects.toBeInstanceOf(RequestedNotWholeCentsError);
  });

  it("is nothing for another tenant's payout", async () => {
    const world = await engineWorld(harness);
    const payout = await world.payout('tenant', usdc(3n * ONE_USDC));
    await world.drive(payout);
    const other = await newTenant(harness.db);
    expect(await databasePaidPayout(harness.db, world.deps.adapters)(other, payout.id)).toBeNull();
  });
});
