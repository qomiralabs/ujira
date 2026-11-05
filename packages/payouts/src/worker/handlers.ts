// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Turning a piece of work into a queue task. The job carries ids, so the handler
// parses them, works from a fresh tenant transaction on the app login, and decides
// what a failure means: another try on the handler's curve, or a dead letter. A
// handler never touches tenant data through the queue's own connection, since
// that login holds nothing in schema ujira.

import { deadLetters, type Database, type ProjectContext } from '@ujira/db';
import type { Task } from 'graphile-worker';

import { afterFailure } from './backoff.js';
import { RetryableJobError, TerminalRefusal } from './errors.js';
import {
  enqueueTask,
  parseTaskPayload,
  TENANT_TASKS,
  type ParsedPayload,
  type TaskIds,
  type TenantTask,
} from './tasks.js';

export interface TenantJob {
  readonly context: ProjectContext;
  readonly ids: TaskIds;
  readonly tryNumber: number;
  // Fires when a shutdown's grace runs out. Work that outlives it holds the
  // shutdown up, so anything slow must honour this.
  readonly signal: AbortSignal;
}

export type TenantWork = (job: TenantJob) => Promise<void>;

// Ids and codes only, because an alert leaves the system.
export type WorkerAlert =
  | {
      readonly kind: 'dead_letter';
      readonly task: string;
      readonly principalId: string;
      readonly projectId: string;
      readonly deadLetterId: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'payout_failed';
      readonly principalId: string;
      readonly projectId: string;
      readonly payoutId: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'payout_needs_attention';
      readonly principalId: string;
      readonly projectId: string;
      readonly payoutId: string;
    }
  | { readonly kind: 'job_exhausted'; readonly task: string; readonly jobId: string }
  | { readonly kind: 'locks_released'; readonly pools: readonly string[] }
  | { readonly kind: 'worker_fault'; readonly operation: string; readonly error: string };

export type Alert = (alert: WorkerAlert) => void;

export interface HandlerDeps {
  readonly db: Database;
  readonly alert: Alert;
  readonly now?: () => number;
}

// Writes the terminal record, then alerts. A crash between the two runs this
// again: the row stays one row, and the alert goes out, because a second alert is
// better than none.
async function writeDeadLetter(
  deps: HandlerDeps,
  task: TenantTask,
  job: ParsedPayload,
  sourceJobId: string,
  reason: string,
): Promise<void> {
  const letter = await deps.db.tenant(job.context).transaction(async (tx) =>
    deadLetters.record(tx, {
      sourceJobId: BigInt(sourceJobId),
      task: task.name,
      ids: job.ids,
      tries: job.tryNumber,
      reason,
    }),
  );
  deps.alert({
    kind: 'dead_letter',
    task: task.name,
    principalId: job.context.principalId,
    projectId: job.context.projectId,
    deadLetterId: letter.id,
    reason,
  });
}

export function tenantTask(task: TenantTask, work: TenantWork, deps: HandlerDeps): Task {
  const now = deps.now ?? (() => Date.now());
  return async (payload, helpers) => {
    const job = parseTaskPayload(task, payload);
    try {
      await work({ ...job, signal: helpers.abortSignal });
    } catch (error) {
      if (!(error instanceof RetryableJobError)) throw error;
      const next = afterFailure(job.tryNumber);
      if (next.kind === 'dead_letter') {
        await writeDeadLetter(deps, task, job, helpers.job.id, error.code);
        return;
      }
      // Under the same key, while this job still holds its lock: the queue moves
      // the key to a new job, and this one completes when the handler returns.
      await deps.db.tenant(job.context).transaction(async (tx) =>
        enqueueTask(tx, task, job.ids, {
          tryNumber: next.tryNumber,
          runAt: new Date(now() + next.delaySeconds * 1_000),
        }),
      );
    }
  };
}

// The net under the handler's curve: a job that crashed or threw something
// unexpected on every one of its attempts. It stays in the queue's table, never
// claimed again, and this is how anyone hears about it.
export async function onJobExhausted(
  deps: HandlerDeps,
  job: { readonly id: string; readonly task_identifier: string; readonly payload: unknown },
  error: unknown,
  tasks: readonly TenantTask[] = TENANT_TASKS,
): Promise<void> {
  const task = tasks.find((candidate) => candidate.name === job.task_identifier);
  if (task === undefined) {
    deps.alert({ kind: 'job_exhausted', task: job.task_identifier, jobId: job.id });
    return;
  }
  let parsed: ParsedPayload;
  try {
    parsed = parseTaskPayload(task, job.payload);
  } catch {
    // No tenant can be read from it, so there is no tenant to file it under.
    deps.alert({ kind: 'job_exhausted', task: job.task_identifier, jobId: job.id });
    return;
  }
  const reason = error instanceof RetryableJobError ? error.code : 'HANDLER_FAILED';
  await writeDeadLetter(deps, task, parsed, job.id, reason);
}

export interface PayoutAdvancePorts<Quote> {
  // Prices the payout and checks every minimum. Throws TerminalRefusal when it
  // refuses, such as AMOUNT_BELOW_MINIMUM, before anything reaches a chain.
  readonly quote: (job: TenantJob) => Promise<Quote>;
  readonly submit: (job: TenantJob, quote: Quote) => Promise<void>;
  // Records the refusal and moves the payout to rejected with the reason.
  readonly reject: (job: TenantJob, reason: string) => Promise<void>;
}

// A refusal ends the job here: nothing is retried, and nothing below a minimum is
// ever attempted on a chain.
export function payoutAdvance<Quote>(ports: PayoutAdvancePorts<Quote>): TenantWork {
  return async (job) => {
    let quote: Quote;
    try {
      quote = await ports.quote(job);
    } catch (error) {
      if (!(error instanceof TerminalRefusal)) throw error;
      await ports.reject(job, error.code);
      return;
    }
    await ports.submit(job, quote);
  };
}
