// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Picks the one network and the rails a payout settles on. The integrator
// never chooses. Preference is data: corridors and their priorities come from
// the routing configuration, and everything about a network comes from its
// adapter, so nothing here knows which chain or rail it is looking at.

import { instanceIdOf, servableInstances } from '@ujira/mandates';
import type { ComplianceStore } from '@ujira/mandates';
import { add, compare, subtract } from '@ujira/core';
import type { FiatCurrencyCode, Money, TokenAmount, TokenAsset } from '@ujira/core';
import type {
  AdapterCapabilities,
  CallOptions,
  ChainAdapter,
  ChainAdapterRegistry,
  ChainHealth,
  CountryCode,
  DeadProof,
  HealthState,
  MandateRef,
  MandateSnapshot,
  NetworkId,
  Quote,
  RailId,
  TenantScope,
  Uuid,
} from '@ujira/chain-adapter';
import type { PayoutMethod } from '@ujira/api-schema';

import type { CorridorCandidate, CorridorConfig, RailConfig, RoutingConfig } from './config.js';
import { withinDeadline } from './timeout.js';

/** How long the parallel quotes of the cheapest strategy may take. */
export const QUOTE_DEADLINE_MS = 2_000;
/** Bound on each read of a network or a store while selecting. */
export const ROUTE_READ_DEADLINE_MS = 5_000;

type DeliveryCurrency = FiatCurrencyCode | TokenAsset;

export interface RouteLeg {
  readonly method: PayoutMethod;
  readonly currency: DeliveryCurrency;
  readonly amount: TokenAmount;
}

/** The attempt before this one. A live one pins the payout to its network. */
export type PreviousAttempt =
  | { readonly state: 'live'; readonly network: NetworkId }
  | { readonly state: 'dead'; readonly network: NetworkId; readonly proof: DeadProof };

export interface RouteRequest {
  readonly scope: TenantScope;
  readonly mandateId: Uuid;
  readonly recipientId: Uuid;
  readonly country: string;
  readonly total: TokenAmount;
  /** The first leg is the main method, which a payout collapses to. */
  readonly legs: readonly RouteLeg[];
  /** The project's setting: whether a dead attempt may move to another network. */
  readonly chainFallback: 'off' | 'verified_methods';
  readonly previousAttempt?: PreviousAttempt;
  /** Set by the release job: this network only, with this balance in place of the chain's. */
  readonly release?: { readonly network: NetworkId; readonly free: TokenAmount };
  readonly correlationId: string;
}

/** A method the recipient has verified, usable on one network and rail kind. */
export interface VerifiedDestination {
  readonly recipientMethodId: Uuid;
  readonly method: PayoutMethod;
  readonly network: NetworkId;
  readonly rail: RailId;
  /** The anchor it was verified with, or absent when any rail of the kind can use it. */
  readonly provider?: string;
}

export interface VerifiedDestinations {
  list(
    scope: TenantScope,
    recipientId: Uuid,
    opts: { readonly signal: AbortSignal },
  ): Promise<readonly VerifiedDestination[]>;
}

export interface MandateInstance {
  readonly mandateInstanceId: string;
  readonly ref: MandateRef;
}

export interface MandateInstances {
  list(
    scope: TenantScope,
    mandateId: Uuid,
    opts: { readonly signal: AbortSignal },
  ): Promise<readonly MandateInstance[]>;
  /**
   * What is routed on this instance but not yet requested on chain. The
   * chain's free balance cannot show it yet, so a balance that ignored it
   * would promise the same funds twice.
   */
  unrequested(
    scope: TenantScope,
    mandateInstanceId: string,
    zero: TokenAmount,
    opts: { readonly signal: AbortSignal },
  ): Promise<TokenAmount>;
}

/** Adapters report per rail kind, so a provider's own state comes from here. */
export interface ProviderHealth {
  state(
    network: NetworkId,
    provider: string,
    opts: { readonly signal: AbortSignal },
  ): Promise<HealthState>;
}

export interface RouteQuoteRequest {
  readonly scope: TenantScope;
  readonly rail: RailConfig;
  readonly country: string;
  readonly currency: DeliveryCurrency;
  readonly amount: TokenAmount;
  readonly recipientMethodId: Uuid;
}

export interface RouteQuotes {
  quote(req: RouteQuoteRequest, opts: CallOptions): Promise<Quote>;
}

export interface RouteDeps {
  readonly config: () => RoutingConfig;
  readonly adapters: ChainAdapterRegistry;
  readonly mandates: MandateInstances;
  readonly destinations: VerifiedDestinations;
  readonly quotes: RouteQuotes;
  readonly compliance: ComplianceStore;
  /** The fee the request builder will set on top of the total. */
  readonly feeFor: (network: NetworkId, total: TokenAmount) => TokenAmount;
  readonly providers?: ProviderHealth;
  readonly quoteDeadlineMs?: number;
  readonly readDeadlineMs?: number;
}

export interface SelectedLeg {
  readonly method: PayoutMethod;
  readonly currency: DeliveryCurrency;
  readonly amount: TokenAmount;
  /** The rail's name in the routing configuration. */
  readonly railConfigId: string;
  readonly rail: RailId;
  readonly recipientMethodId: Uuid;
  /** Present under the cheapest strategy, when this rail's quote succeeded. */
  readonly quote?: Quote;
}

export interface RoutedOutcome {
  readonly kind: 'routed';
  readonly network: NetworkId;
  readonly mandateInstanceId: string;
  readonly mandate: MandateRef;
  readonly legs: readonly SelectedLeg[];
  /** The total plus the fee: what the mandate's free balance must cover. */
  readonly charged: TokenAmount;
  /** The legs became one on the main method, because no network served them all. */
  readonly collapsed: boolean;
  /** Paid by another verified method, because the requested one had no usable rail. */
  readonly methodFallback: boolean;
  /** Nothing healthy remained, so a degraded path was taken. */
  readonly degraded: boolean;
  readonly quoteFailures: number;
}

export interface NetworkShortfall {
  readonly network: NetworkId;
  readonly mandateInstanceId: string;
  readonly needed: TokenAmount;
}

export type UnavailableReason = 'network_down' | 'rail_down' | 'unreadable';

export type RouteOutcome =
  | RoutedOutcome
  /** Every candidate network is short of funds. Nothing is requested on chain. */
  | { readonly kind: 'hold'; readonly networks: readonly NetworkShortfall[] }
  /** Something could serve this, but not right now. */
  | {
      readonly kind: 'unavailable';
      readonly networks: readonly {
        readonly network: NetworkId;
        readonly reason: UnavailableReason;
      }[];
    }
  /** Nothing configured and verified can serve this. */
  | { readonly kind: 'no_route' };

interface Option {
  readonly rail: RailConfig;
  readonly corridor: CorridorConfig;
  readonly priority: number;
  readonly destination: VerifiedDestination;
  readonly health: HealthState;
}

interface LegSpec {
  readonly amount: TokenAmount;
  /** The corridors that may serve the leg, the ones that matter most first. */
  readonly corridors: readonly CorridorConfig[];
}

interface Chosen {
  readonly option: Option;
  readonly quote?: Quote;
}

type NetworkState =
  | { readonly kind: 'excluded' }
  | { readonly kind: 'unavailable'; readonly reason: UnavailableReason }
  | { readonly kind: 'short'; readonly shortfall: NetworkShortfall }
  | {
      readonly kind: 'ready';
      readonly network: NetworkId;
      readonly instance: MandateInstance;
      readonly charged: TokenAmount;
      readonly options: readonly (readonly Option[])[];
      readonly settlementSeconds: number;
    };

const SEVERITY: Readonly<Record<HealthState, number>> = { healthy: 0, degraded: 1, down: 2 };

function worst(...states: readonly HealthState[]): HealthState {
  return states.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'healthy');
}

function networksAllowed(req: RouteRequest): ((network: NetworkId) => boolean) | null {
  if (req.release !== undefined) {
    const { network } = req.release;
    return (candidate) => candidate === network;
  }
  const previous = req.previousAttempt;
  if (previous === undefined) return null;
  // A proof for some other network says nothing about this attempt, so the
  // attempt counts as live. Moving only happens on proof, and only if the
  // project opted in.
  const provenDead = previous.state === 'dead' && previous.proof.network === previous.network;
  if (provenDead && req.chainFallback === 'verified_methods') return null;
  return (candidate) => candidate === previous.network;
}

function usableOn(
  rail: RailConfig,
  method: PayoutMethod,
  destinations: readonly VerifiedDestination[],
): VerifiedDestination | undefined {
  return destinations.find(
    (d) =>
      d.method === method &&
      d.network === rail.network &&
      d.rail === rail.rail &&
      (d.provider === undefined || d.provider === rail.provider),
  );
}

// An amount and a limit on it are compared only in the same unit, so a limit
// quoted in another token can never pass by accident.
function withinLimits(amount: TokenAmount, cap: AdapterCapabilities['rails'][number]): boolean {
  if (cap.minLeg !== undefined && compare(amount, cap.minLeg) < 0) return false;
  return cap.maxLeg === undefined || compare(amount, cap.maxLeg) <= 0;
}

function railCapable(
  caps: AdapterCapabilities,
  rail: RailConfig,
  country: string,
  currency: DeliveryCurrency,
  amount: TokenAmount,
): boolean {
  const cap = caps.rails.find((r) => r.rail === rail.rail);
  if (cap?.enabled !== true) return false;
  // An empty list means the rail is not limited by country.
  const inCountry = cap.countries.length === 0 || cap.countries.includes(country as CountryCode);
  return inCountry && cap.deliveryCurrencies.includes(currency) && withinLimits(amount, cap);
}

class Selection {
  readonly #req: RouteRequest;
  readonly #deps: RouteDeps;
  readonly #config: RoutingConfig;
  readonly #allowed: ((network: NetworkId) => boolean) | null;
  readonly #readMs: number;
  readonly #health = new Map<NetworkId, Promise<ChainHealth | null>>();
  readonly #snapshots = new Map<NetworkId, Promise<MandateSnapshot | null>>();
  #destinations: readonly VerifiedDestination[] = [];
  #instances: readonly MandateInstance[] = [];
  #quoteFailures = 0;

  constructor(req: RouteRequest, deps: RouteDeps) {
    this.#req = req;
    this.#deps = deps;
    this.#config = deps.config();
    this.#allowed = networksAllowed(req);
    this.#readMs = deps.readDeadlineMs ?? ROUTE_READ_DEADLINE_MS;
  }

  async run(): Promise<RouteOutcome> {
    const { scope, recipientId, mandateId, legs, total } = this.#req;
    const main = legs[0];
    if (main === undefined) return { kind: 'no_route' };
    // These two are ours, not a network's. If they cannot be read the answer
    // is unknown, so the failure goes to the caller's bounded retry instead of
    // looking like a recipient with no methods.
    this.#destinations = await this.#read((opts) =>
      this.#deps.destinations.list(scope, recipientId, opts),
    );
    this.#instances = await this.#read((opts) => this.#deps.mandates.list(scope, mandateId, opts));
    const own = (leg: RouteLeg): readonly CorridorConfig[] =>
      this.#config.corridors.filter(
        (c) =>
          c.enabled &&
          c.country === this.#req.country &&
          c.method === leg.method &&
          c.currency === leg.currency,
      );
    const asked = legs.map((leg): LegSpec => ({ amount: leg.amount, corridors: own(leg) }));
    const attempts: {
      readonly legs: readonly LegSpec[];
      readonly collapsed: boolean;
      readonly methodFallback: boolean;
    }[] = [{ legs: asked, collapsed: false, methodFallback: false }];
    const collapsed = legs.length > 1;
    if (collapsed) {
      attempts.push({
        legs: [{ amount: total, corridors: own(main) }],
        collapsed,
        methodFallback: false,
      });
    }
    // Last, so a recipient who chose local currency keeps it for as long as any
    // rail of that method works, even a degraded one.
    attempts.push({
      legs: [{ amount: total, corridors: this.#otherMethods(main) }],
      collapsed,
      methodFallback: true,
    });
    let unavailable: RouteOutcome | null = null;
    for (const attempt of attempts) {
      const outcome = await this.#decide(attempt.legs, attempt.collapsed, attempt.methodFallback);
      if (outcome.kind === 'routed' || outcome.kind === 'hold') return outcome;
      if (outcome.kind === 'unavailable') unavailable ??= outcome;
    }
    return unavailable ?? { kind: 'no_route' };
  }

  #otherMethods(main: RouteLeg): readonly CorridorConfig[] {
    const verified = new Set(this.#destinations.map((d) => d.method));
    return this.#config.corridors.filter(
      (c) =>
        c.enabled &&
        c.country === this.#req.country &&
        c.method !== main.method &&
        verified.has(c.method),
    );
  }

  #read<T>(run: (opts: { readonly signal: AbortSignal }) => Promise<T>): Promise<T> {
    return withinDeadline((signal) => run({ signal }), this.#readMs).then((result) => {
      if (result.ok) return result.value;
      throw result.error;
    });
  }

  #callOptions(signal: AbortSignal): CallOptions {
    return { signal, correlationId: this.#req.correlationId };
  }

  #networkHealth(adapter: ChainAdapter): Promise<ChainHealth | null> {
    const known = this.#health.get(adapter.network);
    if (known !== undefined) return known;
    const read = withinDeadline(
      (signal) => adapter.health(this.#callOptions(signal)),
      this.#readMs,
    ).then((result) => (result.ok ? result.value : null));
    this.#health.set(adapter.network, read);
    return read;
  }

  #snapshot(adapter: ChainAdapter, instance: MandateInstance): Promise<MandateSnapshot | null> {
    const known = this.#snapshots.get(adapter.network);
    if (known !== undefined) return known;
    const read = withinDeadline(
      (signal) =>
        adapter.readMandate(
          { scope: this.#req.scope, mandate: instance.ref },
          this.#callOptions(signal),
        ),
      this.#readMs,
    ).then((result) => (result.ok ? result.value : null));
    this.#snapshots.set(adapter.network, read);
    return read;
  }

  async #providerState(rail: RailConfig): Promise<HealthState> {
    const { providers } = this.#deps;
    if (providers === undefined || rail.provider === undefined) return 'healthy';
    const { provider } = rail;
    const result = await withinDeadline(
      (signal) => providers.state(rail.network, provider, { signal }),
      this.#readMs,
    );
    return result.ok ? result.value : 'down';
  }

  async #optionsFor(
    network: NetworkId,
    leg: LegSpec,
    caps: AdapterCapabilities | null,
    health: ChainHealth | null,
  ): Promise<{ readonly all: readonly Option[]; readonly configured: boolean }> {
    const options: Option[] = [];
    let configured = false;
    for (const corridor of leg.corridors) {
      const ordered = [...corridor.candidates].sort((a, b) => a.priority - b.priority);
      for (const candidate of ordered) {
        const option = await this.#option(network, corridor, candidate, leg, caps, health);
        if (option === 'none') continue;
        configured = true;
        if (option !== 'configured') options.push(option);
      }
    }
    return { all: options.sort((a, b) => a.priority - b.priority), configured };
  }

  async #option(
    network: NetworkId,
    corridor: CorridorConfig,
    candidate: CorridorCandidate,
    leg: LegSpec,
    caps: AdapterCapabilities | null,
    health: ChainHealth | null,
  ): Promise<Option | 'configured' | 'none'> {
    const rail = this.#config.rails.find((r) => r.id === candidate.rail);
    if (rail?.enabled !== true || rail.network !== network) return 'none';
    const destination = usableOn(rail, corridor.method, this.#destinations);
    if (destination === undefined) return 'none';
    // From here the rail is one this payout could use, so losing it means the
    // payout should wait, rather than that nothing can serve it.
    if (caps === null || health === null) return 'configured';
    if (!railCapable(caps, rail, this.#req.country, corridor.currency, leg.amount)) return 'none';
    const railState = health.rails.find((r) => r.rail === rail.rail)?.state ?? health.state;
    const state = worst(railState, await this.#providerState(rail));
    if (state === 'down') return 'configured';
    return {
      rail,
      corridor,
      priority: candidate.priority,
      destination,
      health: worst(state, health.state),
    };
  }

  async #freeBalance(instance: MandateInstance, snapshot: MandateSnapshot): Promise<TokenAmount> {
    if (this.#req.release !== undefined) return this.#req.release.free;
    const { free } = snapshot.state;
    const zero = subtract(free, free);
    const promised = await this.#read((opts) =>
      this.#deps.mandates.unrequested(this.#req.scope, instance.mandateInstanceId, zero, opts),
    );
    return subtract(free, promised);
  }

  async #assess(adapter: ChainAdapter, legs: readonly LegSpec[]): Promise<NetworkState> {
    const { network } = adapter;
    const instance = this.#instances.find((i) => i.ref.network === network);
    if (instance === undefined) return { kind: 'excluded' };
    const unread = await Promise.all(legs.map((leg) => this.#optionsFor(network, leg, null, null)));
    if (!unread.every((leg) => leg.configured)) return { kind: 'excluded' };
    const { scope, mandateId, total } = this.#req;
    const key = {
      principalId: scope.principalId,
      projectId: scope.projectId,
      instanceId: instanceIdOf({ ...scope, mandateId }, network),
    };
    const servable = await servableInstances([{ key }], {
      compliance: this.#deps.compliance,
      timeoutMs: this.#readMs,
    });
    if (servable.length === 0) return { kind: 'excluded' };
    const health = await this.#networkHealth(adapter);
    if (health === null) return { kind: 'unavailable', reason: 'unreadable' };
    if (health.state === 'down') return { kind: 'unavailable', reason: 'network_down' };
    const caps = adapter.capabilities();
    if (!caps.settlementAssets.includes(total.asset) || legs.length > caps.maxLegs) {
      return { kind: 'excluded' };
    }
    const assessed = await Promise.all(
      legs.map((leg) => this.#optionsFor(network, leg, caps, health)),
    );
    if (!assessed.every((leg) => leg.configured)) return { kind: 'excluded' };
    if (!assessed.every((leg) => leg.all.length > 0)) {
      return { kind: 'unavailable', reason: 'rail_down' };
    }
    const snapshot = await this.#snapshot(adapter, instance);
    if (snapshot === null) return { kind: 'unavailable', reason: 'unreadable' };
    const { state } = snapshot;
    if (
      !snapshot.trustedFactory ||
      !snapshot.tenantTagMatches ||
      state.paused ||
      state.revoked ||
      state.expired
    ) {
      return { kind: 'excluded' };
    }
    const charged = add(total, this.#deps.feeFor(network, total));
    const free = await this.#freeBalance(instance, snapshot);
    if (compare(free, charged) < 0) {
      return {
        kind: 'short',
        shortfall: {
          network,
          mandateInstanceId: instance.mandateInstanceId,
          needed: subtract(charged, free),
        },
      };
    }
    return {
      kind: 'ready',
      network,
      instance,
      charged,
      options: assessed.map((leg) => leg.all),
      settlementSeconds: caps.typicalSettlementSeconds,
    };
  }

  async #decide(
    legs: readonly LegSpec[],
    collapsed: boolean,
    methodFallback: boolean,
  ): Promise<RouteOutcome> {
    if (legs.some((leg) => leg.corridors.length === 0)) return { kind: 'no_route' };
    const adapters = this.#deps.adapters
      .list()
      .filter((a) => this.#allowed === null || this.#allowed(a.network));
    const assessed = await Promise.all(
      adapters.map(async (adapter) => ({
        network: adapter.network,
        state: await this.#assess(adapter, legs),
      })),
    );
    const ready = assessed.flatMap(({ state }) => (state.kind === 'ready' ? [state] : []));
    if (ready.length > 0) return this.#choose(ready, legs, collapsed, methodFallback);
    const unavailable = assessed.flatMap(({ network, state }) =>
      state.kind === 'unavailable' ? [{ network, reason: state.reason }] : [],
    );
    // A network that might have the funds but cannot answer is not a shortfall,
    // and a deposit would not help it.
    if (unavailable.length > 0) return { kind: 'unavailable', networks: unavailable };
    const short = assessed.flatMap(({ state }) =>
      state.kind === 'short' ? [state.shortfall] : [],
    );
    if (short.length > 0) return { kind: 'hold', networks: short };
    return { kind: 'no_route' };
  }

  async #choose(
    ready: readonly Extract<NetworkState, { kind: 'ready' }>[],
    legs: readonly LegSpec[],
    collapsed: boolean,
    methodFallback: boolean,
  ): Promise<RoutedOutcome> {
    const healthyOnly = (options: readonly Option[]): readonly Option[] => {
      const healthy = options.filter((o) => o.health === 'healthy');
      return healthy.length > 0 ? healthy : options;
    };
    const planned = await Promise.all(
      ready.map(async (state) => {
        const picks = await Promise.all(
          state.options.map((options, index) =>
            this.#pick(healthyOnly(options), legs[index]?.amount ?? this.#req.total),
          ),
        );
        return {
          state,
          picks,
          degraded: picks.some((p) => p.option.health !== 'healthy'),
        };
      }),
    );
    // Degraded only when nothing healthy remains.
    const anyHealthy = planned.some((p) => !p.degraded);
    const pool = anyHealthy ? planned.filter((p) => !p.degraded) : planned;
    const rank = (plan: (typeof planned)[number]): number => plan.picks[0]?.option.priority ?? 0;
    const cost = (plan: (typeof planned)[number]): TokenAmount | null => {
      const sells = plan.picks.map((p) => p.quote?.sell);
      if (sells.some((s) => s === undefined)) return null;
      return (sells as readonly TokenAmount[]).reduce((a, b) => add(a, b));
    };
    const byPreference = [...pool].sort((a, b) => {
      const costA = cost(a);
      const costB = cost(b);
      if (costA !== null && costB !== null) {
        const byCost = compare(costA, costB);
        if (byCost !== 0) return byCost;
        const bySpeed = a.state.settlementSeconds - b.state.settlementSeconds;
        if (bySpeed !== 0) return bySpeed;
      }
      return rank(a) - rank(b);
    });
    const best = byPreference[0];
    if (best === undefined) throw new RangeError('no plan to choose from');
    return Object.freeze({
      kind: 'routed',
      network: best.state.network,
      mandateInstanceId: best.state.instance.mandateInstanceId,
      mandate: best.state.instance.ref,
      charged: best.state.charged,
      collapsed,
      methodFallback,
      degraded: best.degraded,
      quoteFailures: this.#quoteFailures,
      legs: Object.freeze(
        best.picks.map(({ option, quote }, index): SelectedLeg => ({
          method: option.corridor.method,
          currency: option.corridor.currency,
          amount: legs[index]?.amount ?? this.#req.total,
          railConfigId: option.rail.id,
          rail: option.rail.rail,
          recipientMethodId: option.destination.recipientMethodId,
          ...(quote === undefined ? {} : { quote }),
        })),
      ),
    });
  }

  async #pick(options: readonly Option[], amount: TokenAmount): Promise<Chosen> {
    const first = options[0];
    if (first === undefined) throw new RangeError('a ready network has an option for every leg');
    if (first.corridor.strategy === 'priority') return { option: first };
    const ms = this.#deps.quoteDeadlineMs ?? QUOTE_DEADLINE_MS;
    const quoted = await Promise.all(
      options.map(async (option) => {
        const result = await withinDeadline(
          (signal) =>
            this.#deps.quotes.quote(
              {
                scope: this.#req.scope,
                rail: option.rail,
                country: this.#req.country,
                currency: option.corridor.currency,
                amount,
                recipientMethodId: option.destination.recipientMethodId,
              },
              this.#callOptions(signal),
            ),
          ms,
        );
        if (!result.ok) this.#quoteFailures += 1;
        return { option, quote: result.ok ? result.value : undefined };
      }),
    );
    // Options stay in priority order, and the sort is stable, so a tie keeps
    // the preferred rail. A rail that could not quote cannot be compared.
    const priced = quoted.flatMap(({ option, quote }) =>
      quote === undefined ? [] : [{ option, quote }],
    );
    const [best] = [...priced].sort((a, b) => compareQuotes(a.quote, b.quote));
    return best ?? { option: first };
  }
}

function atScale(value: Money, scale: number): bigint {
  return value.amount * 10n ** BigInt(scale - value.scale);
}

/**
 * Lower cost wins, in exact integers. Sell side quotes all cost the same, so
 * where two rails deliver the same currency the comparison is cost per unit
 * delivered, by cross multiplication: no division, so no rounding can decide
 * which rail gets the payout.
 */
export function compareQuotes(a: Quote, b: Quote): number {
  if (a.buy.currency !== b.buy.currency) return compare(a.sell, b.sell);
  const scale = Math.max(a.buy.scale, b.buy.scale);
  const left = a.sell.amount * atScale(b.buy, scale);
  const right = b.sell.amount * atScale(a.buy, scale);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The route for one payout, or why there is none yet. Never moves a live
 * attempt: that takes a dead proof, and the project opting in.
 */
export function selectRoute(req: RouteRequest, deps: RouteDeps): Promise<RouteOutcome> {
  return new Selection(req, deps).run();
}

/** Quotes through the network's own adapter. */
export function adapterRouteQuotes(adapters: ChainAdapterRegistry): RouteQuotes {
  return {
    quote(req, opts) {
      const { asset } = req.amount;
      return adapters.get(req.rail.network).quote(
        {
          scope: req.scope,
          rail: req.rail.rail,
          country: req.country as CountryCode,
          sell: { asset },
          buy: { currency: req.currency },
          amount: { side: 'sell', value: req.amount },
          firm: false,
          recipientMethodId: req.recipientMethodId,
        },
        opts,
      );
    },
  };
}
