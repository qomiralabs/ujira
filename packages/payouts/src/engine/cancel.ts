// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Clearing up after a lapse. An attempt proven dead by `payout_lapsed` can never execute,
// but the mandate still counts its funds as committed until someone cancels it, and anyone
// may. The retry does not wait for this when the funds allow it. When they do not, this is
// what frees them, and it then wakes whatever is held waiting on them.
//
// It runs on the mandate's queue, so it does not race that mandate's payouts, and it cancels
// everything lapsed on every run, so no record gets near archiving while waiting its turn.

import {
  isChainAdapterError,
  type NetworkId,
  type PayoutId,
  type Uuid,
} from '@ujira/chain-adapter';
import { cronTargets, payoutEngine, type Database, type LapsedCancelTarget } from '@ujira/db';

import { RetryableJobError } from '../worker/errors.js';
import type { TenantJob, TenantWork } from '../worker/handlers.js';
import { SWEEP_PAGE_SIZE } from '../worker/settings.js';
import { CANCEL_LAPSED, enqueueTask } from '../worker/tasks.js';
import { ENGINE_TIMING } from './advance.js';
import type { EngineDeps } from './plan.js';
import { enqueueRelease } from './release.js';

const PER_RUN = 50;

interface Pending {
  readonly attemptId: string;
  readonly network: string;
  readonly onChainPayoutId: string | null;
}

// True when nothing is left to do for this one, and whether that gave funds back.
async function cancelOne(
  job: TenantJob,
  deps: EngineDeps,
  contract: string,
  attempt: Pending,
): Promise<{ readonly done: boolean; readonly freed: boolean }> {
  // Never sent to a chain, so it holds nothing there.
  if (attempt.onChainPayoutId === null) return { done: true, freed: false };
  const network = attempt.network as NetworkId;
  const adapter = deps.adapters.get(network);
  try {
    const step = await adapter.cancelLapsed(
      {
        scope: {
          principalId: job.context.principalId as Uuid,
          projectId: job.context.projectId as Uuid,
        },
        mandate: { network, address: adapter.parseAddress(contract), specVersion: 1 },
        payoutId: attempt.onChainPayoutId as PayoutId,
      },
      { signal: job.signal, correlationId: attempt.attemptId },
    );
    switch (step.kind) {
      case 'cancelled':
        return { done: step.final, freed: step.final };
      case 'closed':
      case 'absent':
        return { done: true, freed: false };
      case 'submitted':
      case 'not_lapsed':
        return { done: false, freed: false };
    }
  } catch (error) {
    if (isChainAdapterError(error) && error.retryable) {
      throw new RetryableJobError(error.code, { cause: error });
    }
    throw error;
  }
}

export function cancelLapsedWork(deps: EngineDeps): TenantWork {
  return async (job) => {
    const instanceId = job.ids['mandateInstanceId'] ?? '';
    const found = await deps.db.tenant(job.context).transaction(async (tx) => ({
      instance: await payoutEngine.instance(tx, instanceId),
      attempts: await payoutEngine.lapsedUncancelled(tx, instanceId, PER_RUN),
    }));
    if (found.instance === undefined || found.attempts.length === 0) return;
    const contract = found.instance.contractAddress;
    let more = found.attempts.length === PER_RUN;
    for (const attempt of found.attempts) {
      const { done, freed } = await cancelOne(job, deps, contract, attempt);
      if (!done) {
        more = true;
        continue;
      }
      // Together, so funds that came back always wake what was waiting on them. A job that
      // dies before this asks again, and the chain says it is already cancelled.
      await deps.db.tenant(job.context).transaction(async (tx) => {
        await payoutEngine.markLapseCancelled(tx, attempt.attemptId);
        if (freed) await enqueueRelease(tx, job.context, attempt.network);
      });
    }
    if (more) {
      await deps.db.tenant(job.context).transaction(async (tx) => {
        await enqueueTask(tx, CANCEL_LAPSED, job.ids, {
          runAt: new Date(Date.now() + ENGINE_TIMING.finalityPollSeconds * 1_000),
        });
      });
    }
  };
}

// Finds who has something to clear through the one narrow function, and enqueues under each
// tenant in turn. It reaches no chain.
export async function sweepLapsed(db: Database): Promise<number> {
  let after: string | undefined;
  let count = 0;
  for (;;) {
    const cursor = after;
    const page: readonly LapsedCancelTarget[] = await db.unscoped(async (tx) =>
      cronTargets.lapsedCancels(tx, cursor, SWEEP_PAGE_SIZE),
    );
    for (const target of page) {
      await db
        .tenant({ principalId: target.principalId, projectId: target.projectId })
        .transaction(async (tx) => {
          await enqueueTask(tx, CANCEL_LAPSED, {
            mandateInstanceId: target.mandateInstanceId,
            mandateId: target.mandateId,
          });
        });
      count += 1;
    }
    const last = page.at(-1);
    if (last === undefined || page.length < SWEEP_PAGE_SIZE) return count;
    after = last.mandateInstanceId;
  }
}
