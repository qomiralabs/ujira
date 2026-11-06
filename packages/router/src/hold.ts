// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A payout every candidate network is short for waits here rather than
// failing, with nothing requested on chain. A deposit releases what it can
// pay for. Each release is one compare and set in the store, so however many
// jobs reach the same payout, one of them moves it and the others match
// nothing; the one live attempt index is the backstop under that.

import { add, compare, subtract } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';
import type { CallOptions, Deposit, NetworkId, TenantScope, Uuid } from '@ujira/chain-adapter';

import { ROUTE_READ_DEADLINE_MS, selectRoute } from './select.js';
import type {
  MandateInstance,
  NetworkShortfall,
  RouteDeps,
  RouteOutcome,
  RouteRequest,
  RoutedOutcome,
} from './select.js';
import { withinDeadline } from './timeout.js';

export const RELEASE_TASK = 'payouts:release_held';
/** The sweep only enqueues, so a missed deposit waits at most this long. */
export const SWEEP_INTERVAL_SECONDS = 600;
/** The project default for how long a payout may wait for funds: 14 days. */
export const DEFAULT_FUNDING_HOLD_MAX_SECONDS = 1_209_600;
/** How many holds one run looks at. The next sweep picks up any more. */
export const RELEASE_BATCH = 500;

export interface StoreOptions {
  readonly signal: AbortSignal;
}

export interface HeldPayout {
  readonly scope: TenantScope;
  readonly payoutId: Uuid;
  readonly network: NetworkId;
  readonly mandateInstanceId: string;
  readonly needed: TokenAmount;
  readonly heldAt: Date;
}

export interface FundingHoldStore {
  /**
   * In one transaction: `received` gets `status_reason = 'awaiting_funding'`
   * and one row per candidate network. False when the payout is not waiting
   * on a network, so nothing was held.
   */
  hold(
    scope: TenantScope,
    payoutId: Uuid,
    total: TokenAmount,
    shortfalls: readonly NetworkShortfall[],
    opts: StoreOptions,
  ): Promise<boolean>;
  /** Every principal and network with a hold. What the sweep enqueues. */
  heldPairs(opts: StoreOptions): Promise<readonly ReleaseTarget[]>;
  /** Oldest first, across the principal's projects. */
  oldestHeld(
    target: ReleaseTarget,
    limit: number,
    opts: StoreOptions,
  ): Promise<readonly HeldPayout[]>;
  /**
   * One compare and set: `received` and `awaiting_funding` to `routed`, the
   * attempt created, and every hold row of the payout deleted on every
   * network. False when another release got there first.
   */
  release(
    scope: TenantScope,
    payoutId: Uuid,
    route: RoutedOutcome,
    opts: StoreOptions,
  ): Promise<boolean>;
  /** The same compare and set, to `failed` with `funding_hold_expired`. */
  expire(scope: TenantScope, payoutId: Uuid, opts: StoreOptions): Promise<boolean>;
  /** The project's `funding_hold_max_seconds`. */
  maxHoldSeconds(scope: TenantScope, opts: StoreOptions): Promise<number>;
  /** What the router needs to route this payout again. */
  requestOf(scope: TenantScope, payoutId: Uuid, opts: StoreOptions): Promise<RouteRequest>;
  /** The instance a hold is on. */
  instanceOf(
    scope: TenantScope,
    mandateInstanceId: string,
    opts: StoreOptions,
  ): Promise<MandateInstance>;
}

export interface ReleaseTarget {
  readonly principalId: Uuid;
  /**
   * A project of the principal, because a database session opens under one.
   * The job reads across all of them, and this is not part of its job key.
   */
  readonly projectId: Uuid;
  readonly network: NetworkId;
}

/**
 * The job for one principal and network. One queue per pair, so releases for
 * a principal on a network run one at a time, and one job key, so a burst of
 * deposits collapses into one job that sees all of them.
 */
export interface ReleaseJobSpec {
  readonly task: typeof RELEASE_TASK;
  readonly queueName: string;
  readonly jobKey: string;
  readonly target: ReleaseTarget;
}

export function releaseJobSpec(target: ReleaseTarget): ReleaseJobSpec {
  const name = `release_held:${target.principalId}:${target.network}`;
  return Object.freeze({ task: RELEASE_TASK, queueName: name, jobKey: name, target });
}

export interface ReleaseQueue {
  enqueue(spec: ReleaseJobSpec, opts: StoreOptions): Promise<void>;
}

export interface HoldDeps {
  readonly store: FundingHoldStore;
  readonly timeoutMs?: number;
}

function call<T>(
  deps: { readonly timeoutMs?: number },
  run: (o: StoreOptions) => Promise<T>,
): Promise<T> {
  return withinDeadline((signal) => run({ signal }), deps.timeoutMs ?? ROUTE_READ_DEADLINE_MS).then(
    (result) => {
      if (result.ok) return result.value;
      throw result.error;
    },
  );
}

/**
 * The public view of a held payout: queued, awaiting funding, and the least
 * that a deposit on any candidate network would have to bring.
 */
export function heldStatus(shortfalls: readonly NetworkShortfall[]): {
  readonly status: 'queued';
  readonly reason: 'awaiting_funding';
  readonly fundingNeeded: TokenAmount;
} {
  const [first, ...rest] = shortfalls.map((s) => s.needed);
  if (first === undefined) throw new RangeError('a hold names at least one network');
  const fundingNeeded = rest.reduce((a, b) => (compare(b, a) < 0 ? b : a), first);
  return Object.freeze({ status: 'queued', reason: 'awaiting_funding', fundingNeeded });
}

/** Records a hold outcome. Anything else is not this function's business. */
export async function holdPayout(
  scope: TenantScope,
  payoutId: Uuid,
  outcome: Extract<RouteOutcome, { kind: 'hold' }>,
  deps: HoldDeps,
): Promise<boolean> {
  return call(deps, (opts) =>
    deps.store.hold(scope, payoutId, outcome.total, outcome.networks, opts),
  );
}

/** A detected deposit enqueues the job. It never routes anything itself. */
export async function onDeposit(
  deposit: Pick<Deposit, 'scope' | 'mandate'>,
  deps: { readonly queue: ReleaseQueue; readonly timeoutMs?: number },
): Promise<void> {
  const spec = releaseJobSpec({
    principalId: deposit.scope.principalId,
    projectId: deposit.scope.projectId,
    network: deposit.mandate.network,
  });
  await call(deps, (opts) => deps.queue.enqueue(spec, opts));
}

/**
 * Runs every ten minutes, for a deposit that was missed. It only enqueues the
 * same job and never routes, so it adds no second path that could pay.
 */
export async function sweepFundingHolds(deps: {
  readonly store: FundingHoldStore;
  readonly queue: ReleaseQueue;
  readonly timeoutMs?: number;
}): Promise<number> {
  const pairs = await call(deps, (opts) => deps.store.heldPairs(opts));
  for (const target of pairs) {
    const spec = releaseJobSpec(target);
    await call(deps, (opts) => deps.queue.enqueue(spec, opts));
  }
  return pairs.length;
}

export interface ReleaseSummary {
  readonly released: readonly Uuid[];
  readonly expired: readonly Uuid[];
  /** Another job moved these first. */
  readonly lost: readonly Uuid[];
  /** Still held: funds ran out at an older payout, or they cannot be routed now. */
  readonly waiting: readonly Uuid[];
}

export interface ReleaseDeps extends HoldDeps {
  readonly route: RouteDeps;
  readonly now: () => Date;
}

const MS_PER_SECOND = 1_000;

/**
 * The job body. Oldest first, per instance, with a running free balance so one
 * run never promises the same funds twice. It starts from the chain's free
 * balance less what is routed but not yet requested there, which is what makes
 * a job killed halfway safe to run again. When funds run out at a payout, the
 * newer ones on that instance wait too, so a large old payout is not starved
 * by smaller new ones.
 */
export async function runReleaseHeld(
  target: ReleaseTarget,
  deps: ReleaseDeps,
): Promise<ReleaseSummary> {
  const held = await call(deps, (opts) => deps.store.oldestHeld(target, RELEASE_BATCH, opts));
  const released: Uuid[] = [];
  const expired: Uuid[] = [];
  const lost: Uuid[] = [];
  const waiting: Uuid[] = [];
  const running = new Map<string, TokenAmount | 'exhausted'>();
  const maxAge = new Map<string, number>();
  for (const hold of held) {
    const { scope, payoutId, mandateInstanceId } = hold;
    const tenant = JSON.stringify([scope.principalId, scope.projectId]);
    const limit =
      maxAge.get(tenant) ?? (await call(deps, (opts) => deps.store.maxHoldSeconds(scope, opts)));
    maxAge.set(tenant, limit);
    if (deps.now().getTime() - hold.heldAt.getTime() >= limit * MS_PER_SECOND) {
      const moved = await call(deps, (opts) => deps.store.expire(scope, payoutId, opts));
      (moved ? expired : lost).push(payoutId);
      continue;
    }
    const known = running.get(mandateInstanceId);
    if (known === 'exhausted') {
      waiting.push(payoutId);
      continue;
    }
    const request = await call(deps, (opts) => deps.store.requestOf(scope, payoutId, opts));
    const free = known ?? (await freeOn(hold, request, deps));
    if (free === null) {
      running.set(mandateInstanceId, 'exhausted');
      waiting.push(payoutId);
      continue;
    }
    const outcome = await selectRoute(
      { ...request, release: { network: hold.network, free } },
      deps.route,
    );
    if (outcome.kind !== 'routed') {
      // Short of funds stops this instance. Anything else is about this payout.
      if (outcome.kind === 'hold') running.set(mandateInstanceId, 'exhausted');
      else running.set(mandateInstanceId, free);
      waiting.push(payoutId);
      continue;
    }
    const moved = await call(deps, (opts) => deps.store.release(scope, payoutId, outcome, opts));
    if (moved) {
      released.push(payoutId);
      running.set(mandateInstanceId, subtract(free, outcome.charged));
    } else {
      lost.push(payoutId);
      running.set(mandateInstanceId, free);
    }
  }
  return Object.freeze({ released, expired, lost, waiting });
}

async function freeOn(
  hold: HeldPayout,
  request: RouteRequest,
  deps: ReleaseDeps,
): Promise<TokenAmount | null> {
  const { scope, mandateInstanceId, network } = hold;
  const instance = await call(deps, (opts) =>
    deps.store.instanceOf(scope, mandateInstanceId, opts),
  );
  const callOptions = (signal: AbortSignal): CallOptions => ({
    signal,
    correlationId: request.correlationId,
  });
  const read = await withinDeadline(
    (signal) =>
      deps.route.adapters
        .get(network)
        .readMandate({ scope, mandate: instance.ref }, callOptions(signal)),
    deps.timeoutMs ?? ROUTE_READ_DEADLINE_MS,
  );
  // A network that cannot answer releases nothing now; the sweep comes back.
  if (!read.ok) return null;
  const { free } = read.value.state;
  const promised = await call(deps, (opts) =>
    deps.route.mandates.unrequested(scope, mandateInstanceId, subtract(free, free), opts),
  );
  return subtract(free, promised);
}

export interface MemoryPayout {
  readonly request: RouteRequest;
  readonly status: 'received' | 'routed' | 'failed';
  readonly statusReason: 'awaiting_funding' | 'funding_hold_expired' | null;
  readonly attempts: readonly RoutedOutcome[];
}

export interface MemoryFundingHoldStore extends FundingHoldStore {
  add(payoutId: Uuid, request: RouteRequest): void;
  payout(scope: TenantScope, payoutId: Uuid): MemoryPayout | undefined;
  holdsOf(scope: TenantScope, payoutId: Uuid): readonly HeldPayout[];
  /** What the store has routed on an instance and the chain does not show yet. */
  unrequestedOn(scope: TenantScope, mandateInstanceId: string, zero: TokenAmount): TokenAmount;
  setInstances(instances: readonly MandateInstance[]): void;
}

export function createMemoryFundingHoldStore(
  options: {
    readonly now?: () => Date;
    readonly maxHoldSeconds?: number;
  } = {},
): MemoryFundingHoldStore {
  const now = options.now ?? (() => new Date());
  const payouts = new Map<string, MemoryPayout>();
  const holds = new Map<string, HeldPayout[]>();
  const instances = new Map<string, MandateInstance>();
  const idOf = (scope: TenantScope, payoutId: Uuid): string =>
    JSON.stringify([scope.principalId, scope.projectId, payoutId]);
  const heldOnly = (id: string): MemoryPayout | undefined => {
    const payout = payouts.get(id);
    return payout?.status === 'received' && payout.statusReason === 'awaiting_funding'
      ? payout
      : undefined;
  };
  const all = (): readonly HeldPayout[] => [...holds.values()].flat();
  return {
    add(payoutId, request) {
      payouts.set(idOf(request.scope, payoutId), {
        request,
        status: 'received',
        statusReason: null,
        attempts: [],
      });
    },
    payout(scope, payoutId) {
      return payouts.get(idOf(scope, payoutId));
    },
    holdsOf(scope, payoutId) {
      return holds.get(idOf(scope, payoutId)) ?? [];
    },
    setInstances(list) {
      for (const instance of list) instances.set(instance.mandateInstanceId, instance);
    },
    unrequestedOn(scope, mandateInstanceId, zero) {
      const routed = [...payouts.values()]
        .filter(
          ({ request }) =>
            request.scope.principalId === scope.principalId &&
            request.scope.projectId === scope.projectId,
        )
        .flatMap((payout) => payout.attempts)
        .filter((attempt) => attempt.mandateInstanceId === mandateInstanceId)
        .map((attempt) => attempt.charged);
      return routed.reduce((total, charged) => add(total, charged), zero);
    },
    hold(scope, payoutId, _total, shortfalls) {
      const id = idOf(scope, payoutId);
      const payout = payouts.get(id);
      if (payout?.status !== 'received' || payout.statusReason !== null) {
        return Promise.resolve(false);
      }
      payouts.set(id, { ...payout, statusReason: 'awaiting_funding' });
      holds.set(
        id,
        shortfalls.map((s) => ({
          scope,
          payoutId,
          network: s.network,
          mandateInstanceId: s.mandateInstanceId,
          needed: s.needed,
          heldAt: now(),
        })),
      );
      return Promise.resolve(true);
    },
    heldPairs() {
      const seen = new Map<string, ReleaseTarget>();
      for (const hold of all()) {
        const target = {
          principalId: hold.scope.principalId,
          projectId: hold.scope.projectId,
          network: hold.network,
        };
        seen.set(JSON.stringify([target.principalId, target.network]), target);
      }
      return Promise.resolve([...seen.values()]);
    },
    oldestHeld(target, limit) {
      const matching = all()
        .filter((h) => h.scope.principalId === target.principalId && h.network === target.network)
        .sort((a, b) => a.heldAt.getTime() - b.heldAt.getTime());
      return Promise.resolve(matching.slice(0, limit));
    },
    release(scope, payoutId, route) {
      const id = idOf(scope, payoutId);
      const payout = heldOnly(id);
      if (payout === undefined) return Promise.resolve(false);
      payouts.set(id, {
        ...payout,
        status: 'routed',
        statusReason: null,
        attempts: [...payout.attempts, route],
      });
      holds.delete(id);
      return Promise.resolve(true);
    },
    expire(scope, payoutId) {
      const id = idOf(scope, payoutId);
      const payout = heldOnly(id);
      if (payout === undefined) return Promise.resolve(false);
      payouts.set(id, { ...payout, status: 'failed', statusReason: 'funding_hold_expired' });
      holds.delete(id);
      return Promise.resolve(true);
    },
    maxHoldSeconds() {
      return Promise.resolve(options.maxHoldSeconds ?? DEFAULT_FUNDING_HOLD_MAX_SECONDS);
    },
    requestOf(scope, payoutId) {
      const payout = payouts.get(idOf(scope, payoutId));
      if (payout === undefined) return Promise.reject(new RangeError('no such payout'));
      return Promise.resolve(payout.request);
    },
    instanceOf(_scope, mandateInstanceId) {
      const instance = instances.get(mandateInstanceId);
      if (instance === undefined) return Promise.reject(new RangeError('no such instance'));
      return Promise.resolve(instance);
    },
  };
}
