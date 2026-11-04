// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Scheduling work from inside a tenant transaction, so the write and the job
// commit or roll back together. Tenant ids are not an input: the database takes
// them from the transaction and stamps them on the payload.
//
// The database is what enforces every rule here. The types catch a mistake at
// compile time, and an argument left out stays left out of the call, because the
// function refuses NULL for every argument.

import { sql, type Kysely, type RawBuilder } from 'kysely';

import type { Schema } from '../schema.generated.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';

type Tx = Kysely<Schema>;

// Colons, not dots: the crontab parser rejects dots in a task name.
export type TaskName = `${string}:${string}`;

// Who shares a key or a queue. `principal` is for work that must run one at a
// time across all of a principal's projects.
export type JobScope = 'project' | 'principal';

export type JobKeyMode = 'replace' | 'preserve_run_at';

export type JobIds = Readonly<Record<string, string>> & {
  readonly principalId?: never;
  readonly projectId?: never;
};

export interface JobSpec {
  readonly task: TaskName;
  readonly ids: JobIds;
  // Stored with the tenant in front, so two tenants never share one.
  readonly jobKey?: string;
  readonly queueName?: string;
  // Left to the database by default, so jobs of one transaction keep their order.
  readonly runAt?: Date;
  // How many times the worker may try it. 5 when left out.
  readonly maxAttempts?: number;
  readonly keyMode?: JobKeyMode;
  readonly scope?: JobScope;
}

export const jobQueue = {
  // The job's id. Only a project scoped transaction can enqueue.
  enqueue: async (tx: Tx, job: JobSpec): Promise<bigint> => {
    const args: RawBuilder<unknown>[] = [sql`${job.task}`, sql`${JSON.stringify(job.ids)}::jsonb`];
    if (job.jobKey !== undefined) args.push(sql`p_job_key => ${job.jobKey}`);
    if (job.queueName !== undefined) args.push(sql`p_queue => ${job.queueName}`);
    if (job.runAt !== undefined) args.push(sql`p_run_at => ${job.runAt}`);
    if (job.maxAttempts !== undefined) args.push(sql`p_max_attempts => ${job.maxAttempts}`);
    if (job.keyMode !== undefined) args.push(sql`p_key_mode => ${job.keyMode}`);
    if (job.scope !== undefined) args.push(sql`p_scope => ${job.scope}`);
    const result = await sql<{ id: string }>`
      select ujira_jobs.enqueue(${sql.join(args)}) as id
    `.execute(tx);
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('enqueue returned no job');
    return BigInt(id);
  },
};

// What a task registry entry may name. A payload carries ids only, and a handler
// reopens a tenant transaction to read anything else, so nothing personal or
// financial can sit in the jobs table, in a log line or in a dump of the queue. A
// field has to read as an id, and an id of a person is still refused by name.
// `try` is the handler's retry count and `network` names where to work, neither
// of which identifies anyone.
const ID_FIELD = /^[a-z][A-Za-z0-9]*(?:Id|Ref)$/;
const NON_ID_FIELDS: ReadonlySet<string> = new Set(['try', 'network']);
const PERSONAL_FIELD = /national|passport|tax|email|phone|msisdn|birth|name|address/i;
const TENANT_FIELDS: ReadonlySet<string> = new Set(['principalId', 'projectId']);

export function jobPayloadProblems(
  registry: Readonly<Record<string, readonly string[]>>,
): string[] {
  return Object.entries(registry).flatMap(([task, fields]) =>
    fields.flatMap((field) => {
      if (TENANT_FIELDS.has(field)) return [`${task}.${field}: the database adds the tenant ids`];
      const idShaped = ID_FIELD.test(field) && !PERSONAL_FIELD.test(field);
      return idShaped || NON_ID_FIELDS.has(field)
        ? []
        : [`${task}.${field}: a job payload carries ids only`];
    }),
  );
}

// A transaction under a tenant context, as the worker's handlers hold one.
export type TenantTx = Tx;

export interface NewDeadLetter {
  readonly sourceJobId: bigint;
  readonly task: TaskName;
  readonly ids: JobIds;
  readonly tries: number;
  // A code, as the column's check requires. An error's message could say anything.
  readonly reason: string;
}

export interface DeadLetter {
  readonly id: string;
  readonly sourceJobId: bigint;
  readonly task: TaskName;
  readonly ids: Readonly<Record<string, string>>;
  readonly tries: number;
  readonly reason: string;
  readonly createdAt: Date;
  readonly replayedAt: Date | null;
}

interface DeadLetterRow {
  readonly id: string;
  readonly source_job_id: string;
  readonly task: TaskName;
  readonly ids: Readonly<Record<string, string>>;
  readonly tries: number;
  readonly reason: string;
  readonly created_at: Date;
  readonly replayed_at: Date | null;
}

function toDeadLetter(row: DeadLetterRow): DeadLetter {
  return {
    id: row.id,
    sourceJobId: BigInt(row.source_job_id),
    task: row.task,
    ids: row.ids,
    tries: row.tries,
    reason: row.reason,
    createdAt: row.created_at,
    replayedAt: row.replayed_at,
  };
}

const DEAD_LETTER_COLUMNS = sql.raw(
  'id, source_job_id, task, ids, tries, reason, created_at, replayed_at',
);

export const deadLetters = {
  // Writes the row once per job, however many times a job dies on the way.
  record: async (
    tx: Tx,
    input: NewDeadLetter,
  ): Promise<{ readonly id: string; readonly created: boolean }> => {
    const inserted = await sql<{ id: string }>`
      insert into ujira.job_dead_letters
        (principal_id, project_id, source_job_id, task, ids, tries, reason)
      values (
        ujira.current_principal_id(), ujira.current_project_id(),
        ${input.sourceJobId.toString()}::bigint, ${input.task},
        ${JSON.stringify(input.ids)}::jsonb, ${input.tries}, ${input.reason}
      )
      on conflict on constraint job_dead_letters_once do nothing
      returning id
    `.execute(tx);
    const created = inserted.rows[0]?.id;
    if (created !== undefined) return { id: created, created: true };
    const existing = await sql<{ id: string }>`
      select id from ujira.job_dead_letters
       where source_job_id = ${input.sourceJobId.toString()}::bigint
    `.execute(tx);
    const id = existing.rows[0]?.id;
    if (id === undefined) throw new Error('a dead letter conflicted and could not be read back');
    return { id, created: false };
  },

  // Those still waiting for someone to decide.
  open: async (tx: Tx, page: PageRequest): Promise<Page<DeadLetter>> => {
    const limit = checkedLimit(page.limit);
    const after = page.after === undefined ? sql`` : sql`and id > ${page.after}::uuid`;
    const result = await sql<DeadLetterRow>`
      select ${DEAD_LETTER_COLUMNS} from ujira.job_dead_letters
       where replayed_at is null ${after}
       order by id
       limit ${limit + 1}
    `.execute(tx);
    return pageOf(result.rows.map(toDeadLetter), limit, (letter) => letter.id);
  },

  get: async (tx: Tx, id: string): Promise<DeadLetter | undefined> => {
    const result = await sql<DeadLetterRow>`
      select ${DEAD_LETTER_COLUMNS} from ujira.job_dead_letters where id = ${id}::uuid
    `.execute(tx);
    const row = result.rows[0];
    return row === undefined ? undefined : toDeadLetter(row);
  },

  // True for the one caller that got there first, so two operators replaying one
  // letter make one job.
  markReplayed: async (tx: Tx, id: string): Promise<boolean> => {
    const result = await sql`
      update ujira.job_dead_letters set replayed_at = now()
       where id = ${id}::uuid and replayed_at is null
    `.execute(tx);
    return result.numAffectedRows === 1n;
  },
};

// The targets of the cross-tenant crons, each with its own tenant. Called inside
// db.unscoped() on the app login, and the only cross-tenant read that login has.
export interface ReconcileTarget {
  readonly principalId: string;
  readonly projectId: string;
  readonly mandateInstanceId: string;
}

export const cronTargets = {
  reconcile: async (
    tx: Tx,
    after: string | undefined,
    limit: number,
  ): Promise<readonly ReconcileTarget[]> => {
    const result = await sql<{
      principal_id: string;
      project_id: string;
      mandate_instance_id: string;
    }>`
      select principal_id, project_id, mandate_instance_id
        from ujira.reconcile_targets(${after ?? null}::uuid, ${limit})
    `.execute(tx);
    return result.rows.map((row) => ({
      principalId: row.principal_id,
      projectId: row.project_id,
      mandateInstanceId: row.mandate_instance_id,
    }));
  },
};

export interface QueueState {
  readonly reachesTenantData: boolean;
  readonly schemaRevision: number | null;
}

// What a worker pool says about itself, on the worker login inside
// db.unscoped(work, 'worker'). A job is locked by its pool's id, which is what a
// heartbeat is keyed by.
export const workerPools = {
  // Who this connection really logged in as, whatever its URL says.
  login: async (tx: Tx): Promise<string> => {
    const result = await sql<{ login: string }>`select current_user as login`.execute(tx);
    return result.rows[0]?.login ?? '';
  },

  // What a worker checks about the queue before it claims a job, once it knows it is
  // on the worker login, the only one that can read the queue's tables. The revision
  // is null when the worker's schema was never installed.
  queueState: async (tx: Tx): Promise<QueueState> => {
    const state = await sql<{ reaches: boolean; installed: boolean }>`
      select has_schema_privilege(current_user, 'ujira', 'USAGE')
               or has_schema_privilege(current_user, 'ujira', 'CREATE') as reaches,
             to_regclass('graphile_worker.migrations') is not null as installed
    `.execute(tx);
    const row = state.rows[0];
    if (row === undefined) throw new Error('a select with no table returned no row');
    if (!row.installed) return { reachesTenantData: row.reaches, schemaRevision: null };
    const revision = await sql<{ revision: number | null }>`
      select max(id)::int as revision from graphile_worker.migrations
    `.execute(tx);
    return { reachesTenantData: row.reaches, schemaRevision: revision.rows[0]?.revision ?? null };
  },

  beat: async (tx: Tx, poolId: string): Promise<void> => {
    await sql`
      insert into ujira_jobs.worker_heartbeats (worker_id) values (${poolId})
      on conflict (worker_id) do update set last_seen_at = now()
    `.execute(tx);
  },

  forget: async (tx: Tx, poolId: string): Promise<void> => {
    await sql`delete from ujira_jobs.worker_heartbeats where worker_id = ${poolId}`.execute(tx);
  },

  // Every pool holding a lock on a job or a queue, however recently it beat.
  lockHolders: async (tx: Tx): Promise<readonly string[]> => {
    const result = await sql<{ pool: string }>`
      select locked_by as pool from graphile_worker._private_jobs where locked_by is not null
      union
      select locked_by from graphile_worker._private_job_queues where locked_by is not null
      order by 1
    `.execute(tx);
    return result.rows.map((row) => row.pool);
  },

  // Frees the locks of pools that stopped beating, and returns those pools. A lock
  // younger than the limit is left alone even with no heartbeat, because a pool
  // that has only just started may hold a lock before its first beat lands.
  unlockStale: async (tx: Tx, staleAfterSeconds: number): Promise<readonly string[]> => {
    const cutoff = sql`now() - make_interval(secs => ${staleAfterSeconds})`;
    const stale = await sql<{ pool: string }>`
      with holders as (
        select locked_by from graphile_worker._private_jobs where locked_at < ${cutoff}
        union
        select locked_by from graphile_worker._private_job_queues where locked_at < ${cutoff}
      )
      select holders.locked_by as pool
        from holders
        left join ujira_jobs.worker_heartbeats as beat on beat.worker_id = holders.locked_by
       where beat.worker_id is null or beat.last_seen_at < ${cutoff}
       order by 1
    `.execute(tx);
    const pools = stale.rows.map((row) => row.pool);
    if (pools.length > 0) {
      await sql`select graphile_worker.force_unlock_workers(${pools}::text[])`.execute(tx);
    }
    // A killed pool cannot say goodbye, so its row goes once nothing can need it.
    await sql`
      delete from ujira_jobs.worker_heartbeats where last_seen_at < now() - interval '1 day'
    `.execute(tx);
    return pools;
  },
};

export const jobRepositories = { jobQueue, deadLetters } as const;
