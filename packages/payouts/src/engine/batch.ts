// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The batch advance job. One job per batch and mandate, which requests its items in
// packs and then executes them in packs, and hands each to its own payout job once it
// has nothing more to gain from company. It adds no way to pay: every item is the same
// attempt under the same id as a single payout, so what stops a rerun paying twice there
// stops it here, and the mandate records each id once, in a batch or out of one.
//
// One bad item costs only itself. A request refused here is ended with its code. An
// execute refused is on chain with funds committed to it, so it goes to its own job,
// and from there to the bounded retries and a person.

import type { BatchStep, ChainAdapterErrorJson, PayStep } from '@ujira/chain-adapter';
import { isChainAdapterError } from '@ujira/chain-adapter';
import {
  payoutBatches,
  payoutEngine,
  type Payout,
  type PayoutStatusValue,
  type TenantTx,
} from '@ujira/db';

import { RetryableJobError, TerminalRefusal } from '../worker/errors.js';
import type { TenantJob, TenantWork } from '../worker/handlers.js';
import { BATCH_ADVANCE, enqueueTask, PAYOUT_ADVANCE } from '../worker/tasks.js';
import {
  advanceQuote,
  commit,
  ENGINE_TIMING,
  endPayout,
  persistDead,
  persistStep,
  type Prepared,
} from './advance.js';
import { packExecutes, packRequests } from './pack.js';
import { nowOf, type EngineDeps } from './plan.js';
import { TERMINAL_PAYOUT } from './status.js';

const ITEMS_PER_READ = 100;

interface Item {
  readonly job: TenantJob;
  readonly prepared: Prepared;
}

function jobOf(job: TenantJob, payout: Payout): TenantJob {
  return { ...job, ids: { payoutId: payout.id, mandateId: payout.mandateId } };
}

async function itemsOf(job: TenantJob, deps: EngineDeps): Promise<readonly Payout[]> {
  const batchId = job.ids['batchId'] ?? '';
  const mandateId = job.ids['mandateId'] ?? '';
  const found: Payout[] = [];
  let after: string | undefined;
  for (;;) {
    const cursor = after;
    const page = await deps.db.tenant(job.context).transaction(async (tx) =>
      payoutBatches.items(tx, batchId, mandateId, {
        limit: ITEMS_PER_READ,
        ...(cursor === undefined ? {} : { after: cursor }),
      }),
    );
    found.push(...page.items);
    if (page.next === null) return found;
    after = page.next;
  }
}

// A batch is done when every item is terminal or on its way, with nothing left that
// this job would send.
export function batchComplete(statuses: readonly string[]): boolean {
  const pending: ReadonlySet<string> = new Set<PayoutStatusValue>(['received', 'routed']);
  return statuses.every((status) => TERMINAL_PAYOUT.has(status) || !pending.has(status));
}

const WAITS: ReadonlySet<unknown> = new Set(['funding', 'utc_day', 'resume', 'approval']);

const codeOf = (error: ChainAdapterErrorJson): string => error.specName ?? error.code;

// Routes what has no attempt, refusing per item, and reads the rest back into requests.
async function prepareItems(
  job: TenantJob,
  deps: EngineDeps,
  payouts: readonly Payout[],
): Promise<readonly Item[]> {
  const items: Item[] = [];
  for (const payout of payouts) {
    const itemJob = jobOf(job, payout);
    try {
      const prepared = await advanceQuote(itemJob, deps);
      if (prepared !== undefined) items.push({ job: itemJob, prepared });
    } catch (error) {
      if (!(error instanceof TerminalRefusal)) throw error;
      await endPayout(itemJob, deps, payout.status as PayoutStatusValue, 'rejected', error.code);
    }
  }
  return items;
}

async function handOff(tx: TenantTx, item: Item, delaySeconds: number): Promise<void> {
  await enqueueTask(tx, PAYOUT_ADVANCE, item.job.ids, {
    ...(delaySeconds === 0 ? {} : { runAt: new Date(Date.now() + delaySeconds * 1_000) }),
  });
}

// Grouped by contract, because one call speaks to one mandate.
function byMandate(items: readonly Item[]): readonly (readonly Item[])[] {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = item.prepared.request.mandate.address.value;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()];
}

async function call(
  job: TenantJob,
  pack: readonly Item[],
  execute: 'hold' | 'auto',
): Promise<BatchStep> {
  const first = pack[0];
  if (first === undefined) throw new RangeError('a pack has at least one item');
  const { adapter, request } = first.prepared;
  try {
    return await adapter.payBatch(
      {
        scope: request.scope,
        mandate: request.mandate,
        items: pack.map((item) => ({ ...item.prepared.request, execute })),
      },
      { signal: job.signal, correlationId: job.ids['batchId'] ?? '' },
    );
  } catch (error) {
    if (isChainAdapterError(error) && error.retryable) {
      throw new RetryableJobError(error.code, { cause: error });
    }
    throw error;
  }
}

function stepsOf(
  pack: readonly Item[],
  step: BatchStep,
): readonly { readonly item: Item; readonly step: BatchStep['items'][number]['step'] }[] {
  return step.items.flatMap(({ payoutId, step: one }) => {
    const item = pack.find((candidate) => candidate.prepared.request.payoutId === payoutId);
    return item === undefined ? [] : [{ item, step: one }];
  });
}

// One pack of requests, to stay within the mandate's limit. A refused request has reached
// nothing, so it ends here with its code. A failure that might clear goes round again.
async function requestPhase(
  job: TenantJob,
  deps: EngineDeps,
  items: readonly Item[],
): Promise<void> {
  for (const group of byMandate(items)) {
    for (const pack of packRequests(group)) {
      const result = await call(job, pack, 'hold');
      for (const { item, step } of stepsOf(pack, result)) {
        if (step.kind === 'item_failed') {
          if (step.error.retryable || WAITS.has(step.error.waitFor)) continue;
          const status = item.prepared.snapshot.payout.status as PayoutStatusValue;
          await endPayout(item.job, deps, status, 'failed', codeOf(step.error));
          continue;
        }
        if (step.kind === 'dead') await persistDead(item.job, deps, item.prepared, step.proof);
        else await persistStep(item.job, deps, item.prepared, step, { schedule: false });
      }
    }
  }
}

function afterExecute(step: PayStep): boolean {
  return step.kind !== 'held';
}

// One pack of executes. What comes back submitted or further on belongs to its own job
// from here. Returns whether any item is still to execute.
async function executePhase(
  job: TenantJob,
  deps: EngineDeps,
  items: readonly Item[],
): Promise<boolean> {
  let deferred = false;
  for (const group of byMandate(items)) {
    const packs = packExecutes(group, (item) => ({
      legs: item.prepared.request.legs.length,
      fee: item.prepared.request.fee.amount,
    }));
    for (const pack of packs) {
      const result = await call(job, pack, 'auto');
      for (const { item, step } of stepsOf(pack, result)) {
        if (step.kind === 'item_failed') {
          await commit(item.job, deps, async (tx) => {
            await payoutEngine.noteRefusal(
              tx,
              item.prepared.snapshot.payout.id,
              codeOf(step.error),
            );
            await handOff(tx, item, ENGINE_TIMING.waitPollSeconds);
          });
          continue;
        }
        if (step.kind === 'dead') {
          await persistDead(item.job, deps, item.prepared, step.proof);
          continue;
        }
        if (!afterExecute(step)) {
          // Left undecided by the search for an offender. The next run plans it again.
          deferred = true;
          continue;
        }
        await persistStep(item.job, deps, item.prepared, step);
      }
    }
  }
  return deferred;
}

const EXECUTABLE: ReadonlySet<string> = new Set(['requested', 'approved']);

export function batchWork(deps: EngineDeps): TenantWork {
  return async (job) => {
    const items = await prepareItems(job, deps, await itemsOf(job, deps));
    // Past its deadline it may need proving dead, which is its own job's to do.
    const now = nowOf(deps);
    const late = items.filter((item) => now >= item.prepared.attempt.deadline.getTime());
    const current = items.filter((item) => !late.includes(item));
    for (const item of late) {
      await commit(item.job, deps, async (tx) => {
        await handOff(tx, item, 0);
      });
    }
    const toRequest = current.filter((item) => item.prepared.attempt.status === 'created');
    if (toRequest.length > 0) {
      await requestPhase(job, deps, toRequest);
      // A request that has landed is ready to execute, in company again.
      await commit(job, deps, async (tx) => {
        await enqueueTask(tx, BATCH_ADVANCE, job.ids);
      });
      return;
    }
    const toExecute = current.filter((item) => EXECUTABLE.has(item.prepared.attempt.status));
    for (const item of current.filter((one) => !toExecute.includes(one))) {
      await commit(item.job, deps, async (tx) => {
        await handOff(tx, item, 0);
      });
    }
    if (toExecute.length === 0) return;
    const deferred = await executePhase(job, deps, toExecute);
    if (deferred) {
      await commit(job, deps, async (tx) => {
        await enqueueTask(tx, BATCH_ADVANCE, job.ids, {
          runAt: new Date(Date.now() + ENGINE_TIMING.finalityPollSeconds * 1_000),
        });
      });
    }
  };
}

// One job per mandate the batch names, in the transaction that created it, because each
// mandate's work waits in its own queue.
export async function enqueueBatchAdvance(
  tx: TenantTx,
  batchId: string,
  items: readonly Pick<Payout, 'mandateId'>[],
): Promise<void> {
  for (const mandateId of new Set(items.map((item) => item.mandateId))) {
    await enqueueTask(tx, BATCH_ADVANCE, { batchId, mandateId });
  }
}
