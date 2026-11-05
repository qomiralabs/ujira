// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Releasing held payouts over the database. The router decides who goes first and how
// far the balance stretches. This gives it a store whose release is one compare and
// set: the transaction deletes every hold of the payout and fails if there were none,
// so of any number of jobs that reach one payout, one creates its attempt.
//
// A release runs per project under one queue per principal and network. The balance it
// spends belongs to a mandate instance, and an instance has one project.

import type { NetworkId, TenantScope, Uuid } from '@ujira/chain-adapter';
import type { TokenAmount } from '@ujira/core';
import {
  cronTargets,
  fundingHolds,
  LiveAttemptError,
  payoutEngine,
  payouts,
  projects,
  type Database,
  type FundingHoldTarget,
  type Payout,
  type ProjectContext,
  type TenantTx,
} from '@ujira/db';
import {
  runReleaseHeld,
  type FundingHoldStore,
  type HeldPayout,
  type MandateInstance,
  type ReleaseSummary,
  type RouteRequest,
} from '@ujira/router';

import { JobPayloadError } from '../worker/errors.js';
import type { TenantJob, TenantWork } from '../worker/handlers.js';
import { SWEEP_PAGE_SIZE } from '../worker/settings.js';
import { enqueueTask, RELEASE_HELD, PAYOUT_ADVANCE } from '../worker/tasks.js';
import {
  attemptPlan,
  BalanceChanged,
  legsMeetMinimums,
  LostRace,
  recordAttempt,
  routePlan,
  scopeOf,
  type EngineDeps,
  type RoutePlan,
} from './plan.js';

// What one read may ask for. The next run takes up any more, oldest first.
const HOLDS_PER_READ = 100;

const contextOf = (scope: TenantScope): ProjectContext => ({
  principalId: scope.principalId,
  projectId: scope.projectId,
});

function instanceRef(
  deps: EngineDeps,
  network: NetworkId,
  id: string,
  address: string,
): MandateInstance {
  const adapter = deps.adapters.get(network);
  return {
    mandateInstanceId: id,
    ref: { network, address: adapter.parseAddress(address), specVersion: 1 },
  };
}

async function refuse(
  deps: EngineDeps,
  context: ProjectContext,
  payoutId: string,
  code: string,
): Promise<void> {
  await deps.db.tenant(context).transaction(async (tx) => {
    if ((await fundingHolds.release(tx, payoutId)) === 0) return;
    await payoutEngine.end(tx, payoutId, { from: 'received', to: 'rejected', code });
  });
}

export function holdStore(
  deps: EngineDeps,
  context: ProjectContext,
  signal: AbortSignal,
): FundingHoldStore {
  // What each payout's route was planned from, for the release that follows it.
  const plans = new Map<string, { readonly payout: Payout; readonly plan: RoutePlan }>();
  const emptyRequest = (scope: TenantScope, payout: Payout): RouteRequest => ({
    scope,
    mandateId: payout.mandateId as Uuid,
    recipientId: payout.recipientId as Uuid,
    country: '',
    // Never read: the router answers no route to a request with no legs.
    total: payout.total ?? (payout.requested as TokenAmount),
    legs: [],
    chainFallback: 'off',
    correlationId: payout.id,
  });
  return {
    hold: async (scope, payoutId, shortfalls) =>
      deps.db
        .tenant(contextOf(scope))
        .transaction(async (tx) => fundingHolds.hold(tx, payoutId, shortfalls)),
    // The sweep below finds its targets itself, tenant by tenant, so nothing reads this.
    heldPairs: () => Promise.resolve([]),
    oldestHeld: async (target, limit) => {
      const held = await deps.db
        .tenant(context)
        .transaction(async (tx) =>
          fundingHolds.oldestOnNetwork(tx, target.network, Math.min(limit, HOLDS_PER_READ)),
        );
      return held.map((hold): HeldPayout => ({
        scope: scopeOf(context),
        payoutId: hold.payoutId as Uuid,
        network: hold.network as NetworkId,
        mandateInstanceId: hold.mandateInstanceId,
        needed: hold.needed,
        heldAt: hold.heldAt,
      }));
    },
    release: async (_scope, payoutId, route) => {
      const known = plans.get(payoutId);
      if (known === undefined) return false;
      const { payout, plan } = known;
      if (!(await legsMeetMinimums(deps, context, route))) {
        await refuse(deps, context, payoutId, 'AMOUNT_BELOW_MINIMUM');
        return false;
      }
      const key = await deps.db
        .tenant(context)
        .transaction(async (tx) => payoutEngine.idempotencyKey(tx, payoutId));
      if (key === undefined) return false;
      const attempt = await attemptPlan(deps, context, plan, route, key, signal);
      try {
        await deps.db.tenant(context).transaction(async (tx) => {
          await recordAttempt(tx, deps, context, payout, attempt, plan.request.total, key, signal);
          await enqueueTask(tx, PAYOUT_ADVANCE, {
            payoutId,
            mandateId: payout.mandateId,
          });
        });
        return true;
      } catch (error) {
        // Held still, for the next deposit or sweep.
        if (error instanceof BalanceChanged) return false;
        if (error instanceof LostRace || error instanceof LiveAttemptError) return false;
        throw error;
      }
    },
    expire: async (scope, payoutId) =>
      deps.db.tenant(contextOf(scope)).transaction(async (tx) => {
        if ((await fundingHolds.release(tx, payoutId)) === 0) return false;
        const moved = await payouts.transition(tx, payoutId, {
          from: 'received',
          to: 'failed',
          statusReason: 'funding_hold_expired',
        });
        return moved !== undefined;
      }),
    maxHoldSeconds: async (scope) => {
      const settings = await deps.db
        .tenant(contextOf(scope))
        .transaction(async (tx) => projects.settings(tx));
      if (settings === undefined) throw new Error('a hold names no project');
      return settings.fundingHoldMaxSeconds;
    },
    requestOf: async (scope, payoutId) => {
      const payout = await deps.db
        .tenant(context)
        .transaction(async (tx) => payouts.get(tx, payoutId));
      if (payout === undefined) throw new Error('a hold names no payout');
      const plan = await routePlan(deps, context, payout, signal);
      // No legs is no route to the router, so this one keeps waiting and the rest go on.
      if (plan === undefined) return emptyRequest(scope, payout);
      plans.set(payoutId, { payout, plan });
      return plan.request;
    },
    instanceOf: async (scope, mandateInstanceId) => {
      const found = await deps.db
        .tenant(contextOf(scope))
        .transaction(async (tx) => payoutEngine.instance(tx, mandateInstanceId));
      if (found === undefined) throw new Error('a hold names no mandate instance');
      return instanceRef(deps, found.network as NetworkId, found.id, found.contractAddress);
    },
  };
}

export async function releaseHeld(
  deps: EngineDeps,
  context: ProjectContext,
  network: NetworkId,
  signal: AbortSignal,
): Promise<ReleaseSummary> {
  const target = { principalId: context.principalId as Uuid, network };
  return runReleaseHeld(target, {
    store: holdStore(deps, context, signal),
    route: deps.routing,
    now: () => new Date(deps.now === undefined ? Date.now() : deps.now()),
  });
}

export function releaseWork(deps: EngineDeps): TenantWork {
  return async (job: TenantJob) => {
    const network = job.ids['network'] as NetworkId | undefined;
    // The key names the project, because the queue is the principal's. It has to be the
    // one the job runs as.
    if (network === undefined || job.ids['heldProjectId'] !== job.context.projectId) {
      throw new JobPayloadError(RELEASE_HELD.name);
    }
    await releaseHeld(deps, job.context, network, job.signal);
  };
}

// A deposit calls this, and so does the sweep. It routes nothing, so it adds no path
// that could pay.
export async function enqueueRelease(
  tx: TenantTx,
  context: ProjectContext,
  network: string,
): Promise<void> {
  await enqueueTask(tx, RELEASE_HELD, { network, heldProjectId: context.projectId });
}

// For a deposit that was missed. Reads who has holds through the one narrow function,
// then enqueues under each tenant in turn.
export async function sweepHolds(db: Database): Promise<number> {
  let after: FundingHoldTarget | undefined;
  let count = 0;
  for (;;) {
    const page: readonly FundingHoldTarget[] = await db.unscoped(async (tx) =>
      cronTargets.fundingHolds(tx, after, SWEEP_PAGE_SIZE),
    );
    for (const target of page) {
      const context = { principalId: target.principalId, projectId: target.projectId };
      await db.tenant(context).transaction(async (tx) => {
        await enqueueRelease(tx, context, target.network);
      });
      count += 1;
    }
    const last = page.at(-1);
    if (last === undefined || page.length < SWEEP_PAGE_SIZE) return count;
    after = last;
  }
}
