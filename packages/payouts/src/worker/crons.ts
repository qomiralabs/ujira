// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The two crons the worker cannot run without: fanning out reconciliation, and
// freeing the queues a dead pool left locked.

import { chainOf, type NetworkId } from '@ujira/chain-adapter';
import { cronTargets, mandateInstances, workerPools, type Database } from '@ujira/db';
import type { Task } from 'graphile-worker';

import type { Alert } from './handlers.js';
import { STALE_AFTER_SECONDS, SUBMISSION_SWEEP, SWEEP_PAGE_SIZE } from './settings.js';
import { enqueueTask, MANDATE_RECONCILE, TTL_KEEP_ALIVE } from './tasks.js';

export interface SweepDeps {
  readonly db: Database;
  readonly pageSize?: number;
}

// Reads only ids across tenants, through the one narrow function, then gives each
// target a transaction under its own tenant. A failure part way throws, the cron
// job retries, and targets already queued are replaced under their own keys.
export function reconcileSweep(deps: SweepDeps): Task {
  const limit = deps.pageSize ?? SWEEP_PAGE_SIZE;
  return async (_payload, helpers) => {
    let after: string | undefined;
    for (;;) {
      helpers.abortSignal.throwIfAborted();
      const cursor = after;
      const page = await deps.db.unscoped(async (tx) => cronTargets.reconcile(tx, cursor, limit));
      for (const target of page) {
        await deps.db
          .tenant({ principalId: target.principalId, projectId: target.projectId })
          .transaction(async (tx) =>
            enqueueTask(tx, MANDATE_RECONCILE, { mandateInstanceId: target.mandateInstanceId }),
          );
      }
      const last = page.at(-1);
      if (last === undefined || page.length < limit) return;
      after = last.mandateInstanceId;
    }
  };
}

// One per network. The adapter holds the store and the RPC, and this only says when.
export interface SubmissionSweeper {
  reconcileUnresolved(
    sweep: typeof SUBMISSION_SWEEP,
    opts: { readonly signal: AbortSignal; readonly correlationId: string },
  ): Promise<unknown>;
}

// One network failing never stops the others. A failure still fails the job after
// they have all run, so the queue retries it and it can be seen.
export function submissionSweep(sweepers: readonly SubmissionSweeper[]): Task {
  return async (_payload, helpers) => {
    const results = await Promise.allSettled(
      sweepers.map(async (sweeper) =>
        sweeper.reconcileUnresolved(SUBMISSION_SWEEP, {
          signal: helpers.abortSignal,
          correlationId: `submissions:reconcile:${helpers.job.id}`,
        }),
      ),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  };
}

export interface TtlSweepDeps {
  readonly db: Database;
  // The networks this deployment keeps entries alive on.
  readonly networks: readonly NetworkId[];
  readonly pageSize?: number;
}

// Fans out as reconcile:sweep does: ids across tenants through the one narrow
// function, then a transaction under each target's own tenant, where its contract
// can be read. An instance on a chain with no network here is left alone.
export function ttlSweep(deps: TtlSweepDeps): Task {
  const limit = deps.pageSize ?? SWEEP_PAGE_SIZE;
  return async (_payload, helpers) => {
    let after: string | undefined;
    for (;;) {
      helpers.abortSignal.throwIfAborted();
      const cursor = after;
      const page = await deps.db.unscoped(async (tx) => cronTargets.reconcile(tx, cursor, limit));
      for (const target of page) {
        await deps.db
          .tenant({ principalId: target.principalId, projectId: target.projectId })
          .transaction(async (tx) => {
            const instance = await mandateInstances.get(tx, target.mandateInstanceId);
            if (instance === undefined) return;
            for (const network of deps.networks) {
              if (chainOf(network) !== instance.chain) continue;
              await enqueueTask(tx, TTL_KEEP_ALIVE, {
                network,
                mandateRef: instance.contractAddress,
              });
            }
          });
      }
      const last = page.at(-1);
      if (last === undefined || page.length < limit) return;
      after = last.mandateInstanceId;
    }
  };
}

export interface UnlockDeps {
  readonly db: Database;
  readonly alert: Alert;
}

// A killed process holds its job and its whole mandate queue for four hours by
// default. This brings that down to a few minutes.
export function unlockStale(deps: UnlockDeps): Task {
  return async () => {
    const pools = await deps.db.unscoped(
      async (tx) => workerPools.unlockStale(tx, STALE_AFTER_SECONDS),
      'worker',
    );
    if (pools.length > 0) deps.alert({ kind: 'locks_released', pools });
  };
}
