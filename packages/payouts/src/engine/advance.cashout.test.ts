// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Cash-out through an anchor. Nothing here is taken at the testnet launch, where the
// wallet is the only enabled rail, so these run against the fake anchor.

import type { PayRequest, QuoteRequest } from '@ujira/chain-adapter';
import { money } from '@ujira/core';
import { payoutAttempts, payoutEngine, payoutLegs, type Payout, type PayoutLeg } from '@ujira/db';
import { adminQuery } from '@ujira/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { workerHarness, type WorkerHarness } from '../worker/testing/support.js';
import { engineWorld, ONE_USDC, seedTenant, TENANT, usdc, type EngineWorld } from './testing/world.js';

let harness: WorkerHarness;

const delivered = [{ afterSeconds: 0, state: 'delivered', rawStatus: 'completed' }];

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
  await seedTenant(harness);
});

afterAll(async () => {
  await harness.close();
});

async function setBearer(bearer: 'recipient' | 'principal'): Promise<void> {
  await adminQuery(harness.database.url, 'update ujira.projects set cashout_cost_bearer = $1 where id = $2', [
    bearer,
    TENANT.projectId,
  ]);
}

afterEach(async () => {
  await setBearer('recipient');
});

// Any local amount passes when the payout is created. What the engine checks later is
// what is sent.
const passAtCreate = {
  minimum: { toUsd: () => ({ amount: 1_000_000_000n, currency: 'USD', scale: 2 }) },
};

const legsOf = async (payout: Payout): Promise<readonly PayoutLeg[]> =>
  harness.db.tenant(TENANT).transaction(async (tx) => {
    const [attempt] = await payoutAttempts.forPayout(tx, payout.id);
    return payoutLegs.forAttempt(tx, attempt?.id ?? '');
  });

const refusalOf = async (payout: Payout): Promise<string | undefined> =>
  harness.db.tenant(TENANT).transaction(async (tx) => payoutEngine.refusalCode(tx, payout.id));

async function principalPayout(world: EngineWorld, key: string, kobo: bigint): Promise<Payout> {
  await world.addMethod('bank');
  await setBearer('principal');
  return world.payout(key, money(kobo, 'NGN'), { method: 'bank', ...passAtCreate });
}

describe('cash-out', () => {
  it('principal mode requests buy_amount equal to the local amount and sends sell_amount, with the fee leg equal to the take on the grossed-up total', async () => {
    const world = await engineWorld(harness, { anchor: true, anchorSteps: delivered });
    const payout = await principalPayout(world, 'principal-mode', 120_000n);
    const paid = await world.drive(payout);
    expect(paid.status).toBe('paid');

    const quote = world.quotes[0] as QuoteRequest;
    expect(quote.amount.side).toBe('buy');
    expect(quote.amount.value.amount).toBe(120_000n);
    expect(quote.firm).toBe(true);

    // 120000 kobo at 2 per 1000 raw units is 60000000, and the anchor's fee on top.
    const sell = 60_500_000n;
    const sent = world.pays[0] as PayRequest;
    expect(sent.total.amount).toBe(sell);
    expect(sent.legs.map((leg) => leg.amount.amount)).toEqual([sell]);
    expect(sent.fee.amount).toBe(sell / 100n);

    const [leg] = await legsOf(payout);
    expect(leg?.delivery?.receive.amount).toBe(120_000n);
    expect(leg?.delivery?.receive.currency).toBe('NGN');
    expect(leg?.delivery?.costBearer).toBe('principal');
    expect(paid.total?.amount).toBe(sell);
  });

  it('principal mode sends the same quote on every retry', async () => {
    const world = await engineWorld(harness, { anchor: true, anchorSteps: delivered });
    const payout = await principalPayout(world, 'principal-same', 120_000n);
    await world.drive(payout);
    const sent = world.pays as PayRequest[];
    const ids = new Set(sent.map((req) => req.legs[0]?.quoteId));
    expect(sent.length).toBeGreaterThan(1);
    expect(ids.size).toBe(1);
    expect(new Set(sent.map((req) => req.total.amount)).size).toBe(1);
  });

  it('principal mode never pays by another method', async () => {
    const world = await engineWorld(harness, { anchor: true, anchorSteps: delivered });
    const payout = await principalPayout(world, 'principal-only', 120_000n);
    const quoted = world.deps.routing.config();
    const bankOff = {
      ...world.deps,
      routing: {
        ...world.deps.routing,
        config: () => ({
          ...quoted,
          rails: quoted.rails,
          corridors: quoted.corridors,
        }),
        destinations: {
          list: async (...args: Parameters<typeof world.deps.routing.destinations.list>) =>
            (await world.deps.routing.destinations.list(...args)).filter(
              (destination) => destination.method !== 'bank',
            ),
        },
      },
    };
    const ended = await world.drive(payout, { deps: bankOff, runs: 2 });
    expect(ended.status).toBe('rejected');
    expect(await refusalOf(payout)).toBe('NO_ROUTE');
    expect(world.pays).toHaveLength(0);
  });

  it('recipient mode sends the USDC amount as sell_amount and records the anchor buy_amount', async () => {
    const world = await engineWorld(harness, { anchor: true, anchorSteps: delivered });
    await world.addMethod('bank');
    const payout = await world.payout('recipient-mode', usdc(6n * ONE_USDC), { method: 'bank' });
    const paid = await world.drive(payout);
    expect(paid.status).toBe('paid');
    const quote = world.quotes[0] as QuoteRequest;
    expect(quote.amount.side).toBe('sell');
    expect(quote.amount.value.amount).toBe(6n * ONE_USDC);
    const sent = world.pays[0] as PayRequest;
    expect(sent.total.amount).toBe(6n * ONE_USDC);
    expect(sent.fee.amount).toBe((6n * ONE_USDC) / 100n);
    const [leg] = await legsOf(payout);
    // (60000000 less the 500000 fee) at 2 per 1000.
    expect(leg?.delivery?.receive.amount).toBe(119_000n);
  });

  it('the leg delivery row has anchor fee, FX rate, receive amount and bearer', async () => {
    const world = await engineWorld(harness, { anchor: true, anchorSteps: delivered });
    await world.addMethod('bank');
    const payout = await world.payout('delivery-row', usdc(6n * ONE_USDC), { method: 'bank' });
    await world.drive(payout);
    const [leg] = await legsOf(payout);
    expect(leg?.fee.amount).toBe(500_000n);
    expect(leg?.delivery).toMatchObject({
      fxNumerator: 2n,
      fxDenominator: 1_000n,
      costBearer: 'recipient',
    });
    expect(leg?.delivery?.receive).toMatchObject({ amount: 119_000n, currency: 'NGN', scale: 2 });
    expect(leg?.delivery?.quoteId.length).toBeGreaterThan(0);
  });

  it('a leg straight to a wallet has no delivery to record', async () => {
    const world = await engineWorld(harness, { anchor: true, anchorSteps: delivered });
    const payout = await world.payout('wallet-leg', usdc(2n * ONE_USDC));
    await world.drive(payout);
    const [leg] = await legsOf(payout);
    expect(leg?.delivery).toBeNull();
    expect(world.quotes).toHaveLength(0);
  });

  it('with no anchor enabled, a recipient whose main method is mobile money is refused at routing rather than quoted', async () => {
    const world = await engineWorld(harness);
    await world.addMethod('mobile_money', 1);
    const payout = await world.payout('no-anchor', usdc(6n * ONE_USDC), {
      method: 'mobile_money',
      recipientId: world.secondRecipientId,
    });
    const ended = await world.drive(payout, { runs: 2 });
    expect(ended.status).toBe('rejected');
    expect(await refusalOf(payout)).toBe('NO_ROUTE');
    expect(world.quotes).toHaveLength(0);
    expect(world.pays).toHaveLength(0);
  });

  it('with no anchor enabled, principal mode is refused without a quote too', async () => {
    const world = await engineWorld(harness);
    const payout = await principalPayout(world, 'no-anchor-principal', 120_000n);
    const ended = await world.drive(payout, { runs: 2 });
    expect(ended.status).toBe('rejected');
    expect(world.quotes).toHaveLength(0);
    expect(world.pays).toHaveLength(0);
  });

  it('with no anchor enabled, a recipient with a wallet too is paid to the wallet', async () => {
    const world = await engineWorld(harness);
    await world.addMethod('mobile_money');
    const before = await world.balanceOfRecipient();
    const payout = await world.payout('no-anchor-wallet', usdc(6n * ONE_USDC), {
      method: 'mobile_money',
    });
    const paid = await world.drive(payout);
    expect(paid.status).toBe('paid');
    const [leg] = await legsOf(payout);
    expect(leg?.method).toBe('stellar_wallet');
    expect(world.quotes).toHaveLength(0);
    expect((await world.balanceOfRecipient()) - before).toBe(6n * ONE_USDC);
  });
});
