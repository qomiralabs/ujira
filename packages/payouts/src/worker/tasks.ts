// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The task registry. A tenant task is scheduled inside a tenant transaction and
// carries ids only, so a handler reads everything else fresh, under that tenant.
//
// Each task says how its key and queue follow from its ids, so a retry lands under
// the same key and on the same queue as the job it replaces.

import { TTL_KEEP_ALIVE_TASK, type NetworkId } from '@ujira/chain-adapter';
import { jobQueue, type JobScope, type TaskName, type TenantTx } from '@ujira/db';
import { z } from 'zod';

import { JobPayloadError } from './errors.js';

export type TaskIds = Readonly<Record<string, string>>;

export interface TenantTask {
  readonly name: TaskName;
  // The payload's fields, besides the tenant, which the database adds.
  readonly ids: readonly string[];
  readonly jobKey: (ids: TaskIds) => string;
  // Absent for work that need not wait its turn on anything.
  readonly queueName?: (ids: TaskIds) => string;
  // `principal` runs one at a time across all of a principal's projects.
  readonly scope?: JobScope;
}

function need(ids: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = ids[name];
  if (value === undefined) throw new RangeError(`a job needs its ${name}`);
  return value;
}

// One at a time for each deployed mandate, so its contract sees its payouts in
// order, and one slow mandate holds up nobody else.
const mandateQueue = (ids: TaskIds): string => `mandate:${need(ids, 'mandateInstanceId')}`;

export const PAYOUT_ADVANCE: TenantTask = {
  name: 'payout:advance',
  ids: ['payoutId', 'mandateInstanceId'],
  jobKey: (ids) => `payout:${need(ids, 'payoutId')}`,
  queueName: mandateQueue,
};

export const BATCH_ADVANCE: TenantTask = {
  name: 'batch:advance',
  ids: ['batchId', 'mandateInstanceId'],
  jobKey: (ids) => `batch:${need(ids, 'batchId')}`,
  queueName: mandateQueue,
};

export const MANDATE_RECONCILE: TenantTask = {
  name: 'mandate:reconcile',
  ids: ['mandateInstanceId'],
  jobKey: (ids) => `reconcile:${need(ids, 'mandateInstanceId')}`,
  queueName: mandateQueue,
};

// Keeps a mandate's ledger entries from being archived. Not on the mandate's queue,
// because a payout should not wait for this, nor this for a payout.
export const TTL_KEEP_ALIVE: TenantTask = {
  name: TTL_KEEP_ALIVE_TASK.name,
  ids: ['network', 'mandateRef'],
  jobKey: (ids) =>
    TTL_KEEP_ALIVE_TASK.jobKey({
      network: need(ids, 'network') as Parameters<typeof TTL_KEEP_ALIVE_TASK.jobKey>[0]['network'],
      mandateRef: need(ids, 'mandateRef'),
    }),
};

export const TENANT_TASKS: readonly TenantTask[] = [
  PAYOUT_ADVANCE,
  BATCH_ADVANCE,
  MANDATE_RECONCILE,
  TTL_KEEP_ALIVE,
];

export type { NetworkId };

// Tasks that belong to no tenant, started by the crontab.
export const SYSTEM_TASKS = Object.freeze({
  indexerScan: 'indexer:scan',
  reconcileSweep: 'reconcile:sweep',
  submissionSweep: 'submissions:reconcile',
  ttlSweep: 'ttl:sweep',
  unlockStale: 'jobs:unlock_stale',
} as const);

const TRY_FIELD = 'try';
const ID = z.string().min(1).max(128);

export interface ParsedPayload {
  readonly context: { readonly principalId: string; readonly projectId: string };
  readonly ids: TaskIds;
  readonly tryNumber: number;
}

// Strict, so a field nobody declared is refused rather than carried along.
export function parseTaskPayload(task: TenantTask, payload: unknown): ParsedPayload {
  const parsed = z
    .strictObject({
      principalId: z.uuid(),
      projectId: z.uuid(),
      [TRY_FIELD]: z
        .string()
        .regex(/^[1-9][0-9]?$/)
        .optional(),
      ...Object.fromEntries(task.ids.map((name) => [name, ID])),
    })
    .safeParse(payload);
  if (!parsed.success) throw new JobPayloadError(task.name);
  const fields: Readonly<Record<string, string | undefined>> = parsed.data;
  return {
    context: { principalId: need(fields, 'principalId'), projectId: need(fields, 'projectId') },
    ids: Object.fromEntries(task.ids.map((name) => [name, need(fields, name)])),
    tryNumber: Number(fields[TRY_FIELD] ?? '1'),
  };
}

export interface EnqueueOptions {
  readonly tryNumber?: number;
  readonly runAt?: Date;
  readonly maxAttempts?: number;
}

// The one way a tenant task is scheduled, in the caller's own transaction, so the
// job exists only if the write beside it commits.
export async function enqueueTask(
  tx: TenantTx,
  task: TenantTask,
  ids: TaskIds,
  options: EnqueueOptions = {},
): Promise<bigint> {
  return jobQueue.enqueue(tx, {
    task: task.name,
    ids: options.tryNumber === undefined ? ids : { ...ids, [TRY_FIELD]: String(options.tryNumber) },
    jobKey: task.jobKey(ids),
    ...(task.queueName === undefined ? {} : { queueName: task.queueName(ids) }),
    keyMode: 'replace',
    ...(task.scope === undefined ? {} : { scope: task.scope }),
    ...(options.runAt === undefined ? {} : { runAt: options.runAt }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
}
