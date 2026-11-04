// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Two fake networks with a funded mandate on each, a routing document with two
// anchors and a wallet rail, and a recipient with verified methods. The second
// network stays in the fixtures so the multi-network steps of selection keep
// being exercised while only one network is live.

import type {
  ChainAdapter,
  ChainAdapterRegistry,
  CountryCode,
  HealthState,
  NetworkId,
  Quote,
  QuoteId,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { FAKE_SCOPES, deployMandate, fakeAdapterHarness } from '@ujira/chain-adapter/testing';
import type { AdapterHarness, SuiteMandate } from '@ujira/chain-adapter/testing';
import { moneyAt, tokenAmount } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';
import { createMemoryComplianceStore } from '@ujira/mandates';

import { createMemoryFundingHoldStore, parseRoutingConfig } from '../src/index.js';
import type {
  MandateInstance,
  MemoryFundingHoldStore,
  RouteDeps,
  RouteQuotes,
  RouteRequest,
  RoutingConfig,
  VerifiedDestination,
} from '../src/index.js';
import { networkSection } from './fixtures.js';

export const TEST_NET: NetworkId = 'stellar:testnet';
export const PUB_NET: NetworkId = 'stellar:pubnet';
export const SCOPE: TenantScope = FAKE_SCOPES.scope;
export const OTHER_SCOPE: TenantScope = FAKE_SCOPES.otherScope;
export const MANDATE_ID = '10000000-0000-4000-8000-000000000001' as Uuid;
export const RECIPIENT_ID = '20000000-0000-4000-8000-000000000001' as Uuid;

export const usdc = (raw: bigint): TokenAmount => tokenAmount(raw, 'USDC', 'stellar');

interface EditableDocument {
  rails: { id: string; enabled: boolean }[];
  corridors: {
    country: string;
    method: string;
    strategy: string;
    enabled: boolean;
    candidates: { rail: string; priority: number }[];
  }[];
}

function sep31(id: string, network: NetworkId, provider: string): Record<string, unknown> {
  return { id, network, rail: 'stellar.sep31', provider, enabled: true };
}

function wallet(id: string, network: NetworkId): Record<string, unknown> {
  return { id, network, rail: 'stellar.wallet', enabled: true };
}

export function routeConfig(
  edit: (doc: EditableDocument) => void = () => undefined,
): RoutingConfig {
  const corridor = (
    method: string,
    currency: string,
    candidates: { rail: string; priority: number }[],
  ): Record<string, unknown> => ({
    country: 'NG',
    method,
    currency,
    enabled: true,
    strategy: 'priority',
    candidates,
  });
  const doc = {
    schemaVersion: 1,
    networks: { [TEST_NET]: networkSection(), [PUB_NET]: networkSection() },
    rails: [
      sep31('anchor_a', TEST_NET, 'anchor-a.example'),
      sep31('anchor_b', TEST_NET, 'anchor-b.example'),
      wallet('wallet_test', TEST_NET),
      sep31('anchor_pub', PUB_NET, 'anchor-a.example'),
      wallet('wallet_pub', PUB_NET),
    ],
    corridors: [
      corridor('bank', 'NGN', [
        { rail: 'anchor_a', priority: 1 },
        { rail: 'anchor_b', priority: 2 },
        { rail: 'anchor_pub', priority: 3 },
      ]),
      corridor('stellar_wallet', 'USDC', [
        { rail: 'wallet_test', priority: 1 },
        { rail: 'wallet_pub', priority: 2 },
      ]),
    ],
  };
  edit(doc as unknown as EditableDocument);
  return parseRoutingConfig(doc);
}

export const destination = (
  name: string,
  method: VerifiedDestination['method'],
  network: NetworkId,
  rail: VerifiedDestination['rail'],
): VerifiedDestination => ({
  recipientMethodId: `30000000-0000-4000-8000-${name.padStart(12, '0')}` as Uuid,
  method,
  network,
  rail,
});

export const BANK_TEST = destination('1', 'bank', TEST_NET, 'stellar.sep31');
export const BANK_PUB = destination('2', 'bank', PUB_NET, 'stellar.sep31');
export const WALLET_TEST = destination('3', 'stellar_wallet', TEST_NET, 'stellar.wallet');
export const WALLET_PUB = destination('4', 'stellar_wallet', PUB_NET, 'stellar.wallet');

export function fakeQuote(sell: bigint, buy: bigint, network: NetworkId = TEST_NET): Quote {
  return {
    id: 'quote-1' as QuoteId,
    network,
    rail: 'stellar.sep31',
    source: 'sep38',
    firm: false,
    sell: usdc(sell),
    buy: moneyAt(buy, 'NGN', 2),
    fees: [],
    price: { numerator: 1n, denominator: 1n },
    expiresAt: 2_000_000_000n as UnixSeconds,
  };
}

export interface RouteWorld {
  readonly test: AdapterHarness;
  readonly pub: AdapterHarness;
  readonly testMandate: SuiteMandate;
  readonly pubMandate: SuiteMandate;
  readonly deps: RouteDeps;
  readonly compliance: ReturnType<typeof createMemoryComplianceStore>;
  readonly providers: Map<string, HealthState>;
  readonly store: MemoryFundingHoldStore;
  destinations: readonly VerifiedDestination[];
  config: RoutingConfig;
  enabled: readonly ChainAdapter[];
  quotes: RouteQuotes;
  fee: bigint;
  now: Date;
  request(overrides?: Partial<RouteRequest>): RouteRequest;
}

const ANCHOR_SCRIPT = {
  anchorId: 'anchor-a.example',
  currency: 'NGN',
  country: 'NG' as CountryCode,
  rate: { numerator: 1n, denominator: 1n },
  fee: 0n,
  steps: [],
} as const;

export async function routeWorld(
  funding: { readonly test?: bigint; readonly pub?: bigint } = {},
): Promise<RouteWorld> {
  const test = fakeAdapterHarness({ network: TEST_NET });
  const pub = fakeAdapterHarness({ network: PUB_NET });
  test.faults?.anchorScript(ANCHOR_SCRIPT);
  pub.faults?.anchorScript(ANCHOR_SCRIPT);
  const testMandate = await deployMandate(test, { fund: funding.test ?? 100_000n });
  const pubMandate = await deployMandate(pub, { fund: funding.pub ?? 100_000n });
  const compliance = createMemoryComplianceStore();
  const providers = new Map<string, HealthState>();
  const instances: readonly MandateInstance[] = [
    { mandateInstanceId: 'instance-test', ref: testMandate.ref },
    { mandateInstanceId: 'instance-pub', ref: pubMandate.ref },
  ];
  const adapters: ChainAdapterRegistry = {
    get: (network) => {
      const adapter = world.enabled.find((a) => a.network === network);
      if (adapter === undefined) throw new RangeError('network is not enabled');
      return adapter;
    },
    list: () => world.enabled,
  };
  const world: RouteWorld = {
    test,
    pub,
    testMandate,
    pubMandate,
    compliance,
    providers,
    destinations: [BANK_TEST, BANK_PUB, WALLET_TEST, WALLET_PUB],
    config: routeConfig(),
    enabled: [test.adapter, pub.adapter],
    fee: 10n,
    now: new Date('2026-11-02T00:00:00Z'),
    store: createMemoryFundingHoldStore({ now: () => world.now }),
    quotes: { quote: () => Promise.reject(new Error('no quote stubbed')) },
    deps: {
      config: () => world.config,
      adapters,
      compliance,
      mandates: {
        list: (scope) => Promise.resolve(scope === SCOPE ? instances : []),
        unrequested: (scope, id, zero) =>
          Promise.resolve(world.store.unrequestedOn(scope, id, zero)),
      },
      destinations: { list: () => Promise.resolve(world.destinations) },
      quotes: { quote: (req, opts) => world.quotes.quote(req, opts) },
      feeFor: () => usdc(world.fee),
      providers: {
        state: (_network, provider) => Promise.resolve(providers.get(provider) ?? 'healthy'),
      },
    },
    request: (overrides = {}) => ({
      scope: SCOPE,
      mandateId: MANDATE_ID,
      recipientId: RECIPIENT_ID,
      country: 'NG',
      total: usdc(1_000n),
      legs: [{ method: 'bank', currency: 'NGN', amount: usdc(1_000n) }],
      chainFallback: 'off',
      correlationId: 'route-test',
      ...overrides,
    }),
  };
  world.store.setInstances(instances);
  return world;
}
