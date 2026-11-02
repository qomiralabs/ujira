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

export const jobRepositories = { jobQueue } as const;
