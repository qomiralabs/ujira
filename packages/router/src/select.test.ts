// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for route selection (select.ts), against the fake adapter on two
 * fake networks.
 *
 * selectRoute(request, deps) answers routed, hold, unavailable or no_route.
 *
 * - Candidates come from the corridor for the country, method and currency,
 *   in priority order. Disabled rails and networks, and rails the recipient
 *   has no verified destination for, are not candidates.
 * - One network serves every leg, or the payout collapses to the main method.
 * - A network needs a trusted, active, servable mandate whose free balance,
 *   less what is routed but not yet on chain, covers total plus fee, and an
 *   adapter whose capabilities cover the rail, amount and leg count.
 * - Down is dropped, and degraded is used only when nothing healthy remains.
 * - Priority takes the first. Cheapest compares quotes in exact integers under
 *   a deadline, then settlement time, then priority.
 * - The recipient's other verified methods are the last resort, for when the
 *   requested method has no usable rail.
 * - A live attempt never moves. Moving needs a dead proof and the project
 *   opting in.
 * - All short of funds is a hold; a network that cannot answer is not a
 *   shortfall.
 */

import { describe, expect, it, vi } from 'vitest';

import { RAIL_IDS } from '@ujira/chain-adapter';
import type { ChainAdapter, CountryCode, DeadProof, MandateSnapshot } from '@ujira/chain-adapter';
import { moneyAt } from '@ujira/core';
import { instanceIdOf } from '@ujira/mandates';

import {
  BANK_PUB,
  BANK_TEST,
  MANDATE_ID,
  OTHER_SCOPE,
  PUB_NET,
  SCOPE,
  TEST_NET,
  WALLET_PUB,
  WALLET_TEST,
  destination,
  fakeQuote,
  routeConfig,
  routeWorld,
  usdc,
} from '../test/route-world.js';
import type { RouteWorld } from '../test/route-world.js';
import { adapterRouteQuotes, compareQuotes, selectRoute, withinDeadline } from './index.js';
import type { RouteOutcome, RoutedOutcome } from './index.js';

function routed(outcome: RouteOutcome): RoutedOutcome {
  if (outcome.kind !== 'routed') throw new Error(`expected a route, got ${outcome.kind}`);
  return outcome;
}

const rails = (outcome: RouteOutcome): readonly string[] =>
  routed(outcome).legs.map((leg) => leg.railConfigId);

const select = (w: RouteWorld, overrides = {}): Promise<RouteOutcome> =>
  selectRoute(w.request(overrides), w.deps);

const TWO_LEGS = {
  legs: [
    { method: 'stellar_wallet', currency: 'USDC', amount: usdc(600n) },
    { method: 'bank', currency: 'NGN', amount: usdc(400n) },
  ],
} as const;

const deadProof = (network: DeadProof['network']): DeadProof => ({
  kind: 'tombstone',
  network,
  status: 'cancelled',
  at: { ledgerOrBlock: 1n, finality: 'final' },
});

function cheapest(w: RouteWorld): void {
  w.config = routeConfig((doc) => {
    for (const corridor of doc.corridors) corridor.strategy = 'cheapest';
  });
}

function preferPubWallet(w: RouteWorld): void {
  w.config = routeConfig((doc) => {
    const wallet = doc.corridors.find((c) => c.method === 'stellar_wallet');
    if (wallet) {
      wallet.candidates = [
        { rail: 'wallet_pub', priority: 1 },
        { rail: 'wallet_test', priority: 2 },
      ];
    }
  });
}

function withSnapshot(
  adapter: ChainAdapter,
  change: (s: MandateSnapshot) => MandateSnapshot,
): void {
  const read = adapter.readMandate.bind(adapter);
  vi.spyOn(adapter, 'readMandate').mockImplementation(async (req, opts) =>
    change(await read(req, opts)),
  );
}

it('two-leg payout chooses a network serving both or collapses to the main method', async () => {
  const w = await routeWorld();
  preferPubWallet(w);

  // The main leg prefers the second network, but only the first serves both.
  w.destinations = [WALLET_PUB, WALLET_TEST, BANK_TEST];
  const both = routed(await select(w, TWO_LEGS));
  expect(both.network).toBe(TEST_NET);
  expect(both.collapsed).toBe(false);
  expect(both.legs.map((l) => [l.railConfigId, l.amount.amount])).toEqual([
    ['wallet_test', 600n],
    ['anchor_a', 400n],
  ]);

  // With the methods on different networks nothing serves both.
  w.destinations = [WALLET_PUB, BANK_TEST];
  const collapsed = routed(await select(w, TWO_LEGS));
  expect(collapsed.collapsed).toBe(true);
  expect(collapsed.network).toBe(PUB_NET);
  expect(collapsed.legs).toHaveLength(1);
  expect(collapsed.legs[0]).toMatchObject({ method: 'stellar_wallet', railConfigId: 'wallet_pub' });
  expect(collapsed.legs[0]?.amount.amount).toBe(1_000n);
});

it('healthy preferred, degraded used only when nothing healthy', async () => {
  const w = await routeWorld();
  expect(routed(await select(w)).network).toBe(TEST_NET);

  // The preferred network degrades, so the healthy one takes it.
  w.test.faults?.signerDown(true);
  const moved = routed(await select(w));
  expect(moved.network).toBe(PUB_NET);
  expect(moved.degraded).toBe(false);

  // Nothing healthy remains, so the degraded network is used and says so.
  w.pub.faults?.chainDown(true);
  const degraded = routed(await select(w));
  expect(degraded.network).toBe(TEST_NET);
  expect(degraded.degraded).toBe(true);

  // Down is never used.
  w.test.faults?.chainDown(true);
  expect(await select(w)).toEqual({
    kind: 'unavailable',
    networks: [
      { network: TEST_NET, reason: 'network_down' },
      { network: PUB_NET, reason: 'network_down' },
    ],
  });
});

it('cheapest picks the lower total cost and falls back to priority on quote failure', async () => {
  const w = await routeWorld();
  cheapest(w);
  w.destinations = [BANK_TEST];
  // One raw unit apart, and past what a float can tell apart.
  const prices: Record<string, bigint | 'fail' | 'hang'> = {
    anchor_a: 9_007_199_254_740_993n,
    anchor_b: 9_007_199_254_740_992n,
  };
  w.quotes = {
    quote: (req) => {
      const price = prices[req.rail.id];
      if (price === 'fail' || price === undefined) return Promise.reject(new Error('no quote'));
      if (price === 'hang') return new Promise(() => undefined);
      return Promise.resolve(fakeQuote(price, 5_000n));
    },
  };
  const cheaper = routed(await select(w));
  expect(rails(cheaper)).toEqual(['anchor_b']);
  expect(cheaper.legs[0]?.quote?.sell.amount).toBe(9_007_199_254_740_992n);

  // An exact tie keeps the preferred rail.
  prices['anchor_b'] = 9_007_199_254_740_993n;
  expect(rails(await select(w))).toEqual(['anchor_a']);

  // A rail that cannot quote cannot be compared, so the other one is taken.
  prices['anchor_a'] = 'fail';
  const oneFailed = routed(await select(w));
  expect(rails(oneFailed)).toEqual(['anchor_b']);
  expect(oneFailed.quoteFailures).toBe(1);

  // With no quote at all, priority decides, and a hung quote does not hold it up.
  prices['anchor_b'] = 'hang';
  const allFailed = routed(await selectRoute(w.request(), { ...w.deps, quoteDeadlineMs: 10 }));
  expect(rails(allFailed)).toEqual(['anchor_a']);
  expect(allFailed.quoteFailures).toBe(2);
  expect(allFailed.legs[0]?.quote).toBeUndefined();
});

it('live attempt without dead proof keeps its network', async () => {
  const w = await routeWorld();
  const live = { state: 'live', network: PUB_NET } as const;
  expect(routed(await select(w)).network).toBe(TEST_NET);
  expect(routed(await select(w, { previousAttempt: live })).network).toBe(PUB_NET);

  // Even when that network is down: it waits rather than moves.
  w.pub.faults?.chainDown(true);
  expect(await select(w, { previousAttempt: live })).toEqual({
    kind: 'unavailable',
    networks: [{ network: PUB_NET, reason: 'network_down' }],
  });

  // Opting in does not change that without a proof.
  expect((await select(w, { previousAttempt: live, chainFallback: 'verified_methods' })).kind).toBe(
    'unavailable',
  );
});

it('a network whose free covers total but not charged is dropped', async () => {
  // Exactly the total on the preferred network, the fee on top is not covered.
  const w = await routeWorld({ test: 1_000n });
  expect(routed(await select(w)).network).toBe(PUB_NET);
  expect(routed(await select(w)).charged.amount).toBe(1_010n);

  // With no fee the same balance is enough.
  w.fee = 0n;
  expect(routed(await select(w)).network).toBe(TEST_NET);
});

it("anchor down falls back to a second anchor, then to the recipient's Stellar wallet", async () => {
  const w = await routeWorld();
  w.destinations = [BANK_TEST, WALLET_TEST];
  expect(rails(await select(w))).toEqual(['anchor_a']);

  w.providers.set('anchor-a.example', 'down');
  const second = routed(await select(w));
  expect(rails(second)).toEqual(['anchor_b']);
  expect(second.methodFallback).toBe(false);

  w.providers.set('anchor-b.example', 'down');
  const wallet = routed(await select(w));
  expect(rails(wallet)).toEqual(['wallet_test']);
  expect(wallet.methodFallback).toBe(true);
  expect(wallet.legs[0]).toMatchObject({
    method: 'stellar_wallet',
    currency: 'USDC',
    recipientMethodId: WALLET_TEST.recipientMethodId,
  });
});

it("with no anchor enabled the only candidate is the recipient's Stellar wallet", async () => {
  const w = await routeWorld();
  w.destinations = [BANK_TEST, WALLET_TEST];
  w.config = routeConfig((doc) => {
    for (const rail of doc.rails) if (rail.id.startsWith('anchor')) rail.enabled = false;
  });
  expect(rails(await select(w))).toEqual(['wallet_test']);

  // And the same with the anchor rail off in the adapter.
  w.config = routeConfig();
  w.test.faults?.anchorScript(null);
  expect(rails(await select(w))).toEqual(['wallet_test']);
});

describe('selectRoute', () => {
  it('moves a dead attempt only when the project opted in', async () => {
    const w = await routeWorld();
    const dead = { state: 'dead', network: PUB_NET, proof: deadProof(PUB_NET) } as const;
    expect(routed(await select(w, { previousAttempt: dead })).network).toBe(PUB_NET);
    expect(
      routed(await select(w, { previousAttempt: dead, chainFallback: 'verified_methods' })).network,
    ).toBe(TEST_NET);
  });

  it('treats a proof for another network as no proof', async () => {
    const w = await routeWorld();
    const forged = { state: 'dead', network: PUB_NET, proof: deadProof(TEST_NET) } as const;
    expect(
      routed(await select(w, { previousAttempt: forged, chainFallback: 'verified_methods' }))
        .network,
    ).toBe(PUB_NET);
  });

  it('prefers a healthy rail to a degraded one on the same network', async () => {
    const w = await routeWorld();
    w.destinations = [BANK_TEST];
    w.providers.set('anchor-a.example', 'degraded');
    const healthy = routed(await select(w));
    expect(rails(healthy)).toEqual(['anchor_b']);
    expect(healthy.degraded).toBe(false);

    w.providers.set('anchor-b.example', 'degraded');
    const degraded = routed(await select(w));
    expect(rails(degraded)).toEqual(['anchor_a']);
    expect(degraded.degraded).toBe(true);
  });

  it('keeps a degraded requested method ahead of a healthy other method', async () => {
    const w = await routeWorld();
    w.destinations = [BANK_TEST, WALLET_TEST];
    w.providers.set('anchor-a.example', 'degraded');
    w.providers.set('anchor-b.example', 'degraded');
    expect(routed(await select(w)).methodFallback).toBe(false);
  });

  it('holds when every candidate network is short, naming what each needs', async () => {
    const w = await routeWorld({ test: 100n, pub: 900n });
    expect(await select(w)).toEqual({
      kind: 'hold',
      networks: [
        { network: TEST_NET, mandateInstanceId: 'instance-test', needed: usdc(910n) },
        { network: PUB_NET, mandateInstanceId: 'instance-pub', needed: usdc(110n) },
      ],
    });
  });

  it('does not call a network that cannot answer a shortfall', async () => {
    const w = await routeWorld({ test: 100n, pub: 100n });
    w.pub.faults?.chainDown(true);
    expect((await select(w)).kind).toBe('unavailable');
  });

  it('takes what is routed but not on chain off the free balance', async () => {
    const w = await routeWorld({ test: 2_000n });
    const unrequested = vi.spyOn(w.deps.mandates, 'unrequested');
    unrequested.mockImplementation((_s, id, zero) =>
      Promise.resolve(id === 'instance-test' ? usdc(1_500n) : zero),
    );
    expect(routed(await select(w)).network).toBe(PUB_NET);
  });

  it('never uses a noncompliant mandate', async () => {
    const w = await routeWorld();
    const key = {
      principalId: SCOPE.principalId,
      projectId: SCOPE.projectId,
      instanceId: instanceIdOf({ ...SCOPE, mandateId: MANDATE_ID }, TEST_NET),
    };
    await w.compliance.applyMark(
      key,
      { reason: 'principal_key_risk', since: w.now },
      { key, to: 'noncompliant', at: w.now, fixes: [] },
      { signal: new AbortController().signal },
    );
    expect(routed(await select(w)).network).toBe(PUB_NET);
    w.enabled = [w.test.adapter];
    expect(await select(w)).toEqual({ kind: 'no_route' });
  });

  it.each<[string, (s: MandateSnapshot) => MandateSnapshot]>([
    ['untrusted', (s) => ({ ...s, trustedFactory: false })],
    ['another tenant', (s) => ({ ...s, tenantTagMatches: false })],
    ['paused', (s) => ({ ...s, state: { ...s.state, paused: true } })],
    ['revoked', (s) => ({ ...s, state: { ...s.state, revoked: true } })],
    ['expired', (s) => ({ ...s, state: { ...s.state, expired: true } })],
  ])('skips a mandate that is %s', async (_label, change) => {
    const w = await routeWorld();
    withSnapshot(w.test.adapter, change);
    expect(routed(await select(w)).network).toBe(PUB_NET);
  });

  it('skips a disabled network and one with no mandate', async () => {
    const w = await routeWorld();
    w.enabled = [w.pub.adapter];
    expect(routed(await select(w)).network).toBe(PUB_NET);

    const none = await routeWorld();
    expect(await selectRoute(none.request({ scope: OTHER_SCOPE }), none.deps)).toEqual({
      kind: 'no_route',
    });
  });

  it('skips a rail with no verified destination, matching the provider it names', async () => {
    const w = await routeWorld();
    w.destinations = [BANK_PUB];
    expect(rails(await select(w))).toEqual(['anchor_pub']);

    w.destinations = [{ ...BANK_TEST, provider: 'anchor-b.example' }];
    expect(rails(await select(w))).toEqual(['anchor_b']);

    w.destinations = [destination('9', 'mobile_money', TEST_NET, 'stellar.sep31')];
    expect(await select(w)).toEqual({ kind: 'no_route' });
  });

  it('finds nothing with no corridor, a disabled corridor, or no legs', async () => {
    const w = await routeWorld();
    expect(await select(w, { country: 'KE' })).toEqual({ kind: 'no_route' });
    expect(await select(w, { legs: [] })).toEqual({ kind: 'no_route' });
    w.destinations = [BANK_TEST];
    w.config = routeConfig((doc) => {
      for (const corridor of doc.corridors) corridor.enabled = false;
    });
    expect(await select(w)).toEqual({ kind: 'no_route' });
  });

  describe('adapter capabilities', () => {
    function withRail(adapter: ChainAdapter, change: Record<string, unknown>): void {
      const caps = adapter.capabilities();
      vi.spyOn(adapter, 'capabilities').mockReturnValue({
        ...caps,
        rails: caps.rails.map((rail) => ({ ...rail, ...change })),
      });
    }

    it.each<[string, Record<string, unknown>]>([
      ['leg below the minimum', { minLeg: usdc(1_001n) }],
      ['leg above the maximum', { maxLeg: usdc(999n) }],
      ['another country', { countries: ['KE' as CountryCode] }],
      ['another currency', { deliveryCurrencies: ['KES'] }],
      ['switched off', { enabled: false }],
    ])('drops a rail for a %s', async (_label, change) => {
      const w = await routeWorld();
      withRail(w.test.adapter, change);
      expect(routed(await select(w)).network).toBe(PUB_NET);
    });

    it('accepts a leg exactly at both limits', async () => {
      const w = await routeWorld();
      withRail(w.test.adapter, { minLeg: usdc(1_000n), maxLeg: usdc(1_000n) });
      expect(routed(await select(w)).network).toBe(TEST_NET);
    });

    it('drops a network that cannot carry the legs or the asset', async () => {
      const w = await routeWorld();
      const caps = w.test.adapter.capabilities();
      const spy = vi.spyOn(w.test.adapter, 'capabilities');
      spy.mockReturnValue({ ...caps, maxLegs: 1 });
      expect(routed(await select(w, TWO_LEGS)).network).toBe(PUB_NET);
      spy.mockReturnValue({ ...caps, settlementAssets: [] });
      expect(routed(await select(w)).network).toBe(PUB_NET);
    });
  });

  describe('networks that cannot answer', () => {
    it('counts a failed or hung health read as unreadable, not a shortfall', async () => {
      const w = await routeWorld();
      w.enabled = [w.test.adapter];
      const spy = vi.spyOn(w.test.adapter, 'health');
      spy.mockRejectedValue(new Error('rpc down'));
      expect(await select(w)).toEqual({
        kind: 'unavailable',
        networks: [{ network: TEST_NET, reason: 'unreadable' }],
      });
      spy.mockImplementation(() => new Promise(() => undefined));
      expect(await selectRoute(w.request(), { ...w.deps, readDeadlineMs: 10 })).toMatchObject({
        kind: 'unavailable',
      });
    });

    it('counts a failed mandate read as unreadable', async () => {
      const w = await routeWorld();
      w.enabled = [w.test.adapter];
      vi.spyOn(w.test.adapter, 'readMandate').mockRejectedValue(new Error('rpc down'));
      expect(await select(w)).toEqual({
        kind: 'unavailable',
        networks: [{ network: TEST_NET, reason: 'unreadable' }],
      });
    });

    it('waits when every rail of the requested method is down and no other is verified', async () => {
      const w = await routeWorld();
      w.destinations = [BANK_TEST];
      w.providers.set('anchor-a.example', 'down');
      w.providers.set('anchor-b.example', 'down');
      expect(await select(w)).toEqual({
        kind: 'unavailable',
        networks: [{ network: TEST_NET, reason: 'rail_down' }],
      });
    });

    it('counts a provider that cannot answer as down', async () => {
      const w = await routeWorld();
      w.destinations = [BANK_TEST];
      const deps = {
        ...w.deps,
        providers: {
          state: (_n: unknown, provider: string) =>
            provider === 'anchor-a.example'
              ? Promise.reject(new Error('no answer'))
              : Promise.resolve('healthy' as const),
        },
      };
      expect(rails(await selectRoute(w.request(), deps))).toEqual(['anchor_b']);
    });

    it('treats a rail the adapter does not report by the state of its network', async () => {
      const w = await routeWorld();
      const health = w.test.adapter.health.bind(w.test.adapter);
      vi.spyOn(w.test.adapter, 'health').mockImplementation(async (opts) => ({
        ...(await health(opts)),
        rails: [],
      }));
      expect(routed(await select(w)).network).toBe(TEST_NET);
    });

    it('works with no provider health at all', async () => {
      const w = await routeWorld();
      const { providers, ...deps } = w.deps;
      expect(providers).toBeDefined();
      expect(rails(await selectRoute(w.request(), deps))).toEqual(['anchor_a']);
    });

    it('lets a failure of our own stores reach the caller', async () => {
      const w = await routeWorld();
      const down = new Error('db down');
      await expect(
        selectRoute(w.request(), {
          ...w.deps,
          destinations: { list: () => Promise.reject(down) },
        }),
      ).rejects.toBe(down);
    });
  });

  describe('across networks under the cheapest strategy', () => {
    function quotesByNetwork(w: RouteWorld, test: bigint, pub: bigint): void {
      w.quotes = {
        quote: (req) =>
          Promise.resolve(fakeQuote(req.rail.network === TEST_NET ? test : pub, 5_000n)),
      };
    }

    it('takes the lower cost', async () => {
      const w = await routeWorld();
      cheapest(w);
      quotesByNetwork(w, 1_100n, 1_000n);
      expect(routed(await select(w)).network).toBe(PUB_NET);
    });

    it('breaks an exact tie by settlement time, then priority', async () => {
      const w = await routeWorld();
      cheapest(w);
      quotesByNetwork(w, 1_000n, 1_000n);
      expect(routed(await select(w)).network).toBe(TEST_NET);
      const caps = w.pub.adapter.capabilities();
      vi.spyOn(w.pub.adapter, 'capabilities').mockReturnValue({
        ...caps,
        typicalSettlementSeconds: 1,
      });
      expect(routed(await select(w)).network).toBe(PUB_NET);
    });

    it('uses priority when a network could not quote', async () => {
      const w = await routeWorld();
      cheapest(w);
      w.quotes = {
        quote: (req) =>
          req.rail.network === TEST_NET
            ? Promise.reject(new Error('no quote'))
            : Promise.resolve(fakeQuote(1n, 5_000n, PUB_NET)),
      };
      expect(routed(await select(w)).network).toBe(TEST_NET);
    });
  });
});

describe('compareQuotes', () => {
  it('compares cost per unit delivered in exact integers', () => {
    const base = fakeQuote(1_000n, 500_000n);
    expect(compareQuotes(base, fakeQuote(1_001n, 500_000n))).toBe(-1);
    expect(compareQuotes(fakeQuote(1_001n, 500_000n), base)).toBe(1);
    expect(compareQuotes(base, base)).toBe(0);
    // Sell side quotes cost the same, so the better rate delivers more.
    expect(compareQuotes(fakeQuote(1_000n, 500_001n), base)).toBe(-1);
  });

  it('compares the same delivery at different scales', () => {
    const twoPlaces = fakeQuote(1_000n, 500n);
    const fourPlaces = { ...twoPlaces, buy: moneyAt(50_000n, 'NGN', 4) };
    expect(compareQuotes(twoPlaces, fourPlaces)).toBe(0);
  });

  it('compares cost alone across delivery currencies', () => {
    const naira = fakeQuote(1_000n, 500n);
    const dollars = { ...fakeQuote(1_001n, 1n), buy: moneyAt(1n, 'USD', 2) };
    expect(compareQuotes(naira, dollars)).toBe(-1);
  });
});

describe('adapterRouteQuotes', () => {
  it('quotes through the adapter of the rail network', async () => {
    const w = await routeWorld();
    w.destinations = [WALLET_TEST];
    cheapest(w);
    w.quotes = adapterRouteQuotes(w.deps.adapters);
    const route = routed(
      await select(w, {
        legs: [{ method: 'stellar_wallet', currency: 'USDC', amount: usdc(1_000n) }],
      }),
    );
    expect(route.legs[0]?.quote).toMatchObject({ source: 'par', network: TEST_NET });
    expect(route.legs[0]?.quote?.sell.amount).toBe(1_000n);
  });
});

describe('withinDeadline', () => {
  it('aborts a call that outlives its deadline', async () => {
    let seen: AbortSignal | undefined;
    const result = await withinDeadline((signal) => {
      seen = signal;
      return new Promise(() => undefined);
    }, 10);
    expect(result.ok).toBe(false);
    expect(seen?.aborted).toBe(true);
  });

  it('returns the value of a call that answers in time', async () => {
    expect(await withinDeadline(() => Promise.resolve(1), 1_000)).toEqual({ ok: true, value: 1 });
  });
});

it('keeps the rail kinds it compares to what the adapter lists', () => {
  expect(RAIL_IDS).toContain(BANK_TEST.rail);
  expect(RAIL_IDS).toContain(WALLET_TEST.rail);
});
