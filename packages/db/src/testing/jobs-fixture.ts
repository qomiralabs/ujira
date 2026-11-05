// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the job queue tests share: a transaction with its tenant settings written
// out by hand, so a test can give the database a context the repository would
// refuse to send, and a read of the jobs that really exist.

import type pg from 'pg';

export interface RawContext {
  readonly principalId: string;
  readonly projectId: string;
  readonly scope?: string;
}

// Runs the work in one transaction on this client and always rolls back unless
// told to commit, so a refused call cannot leave the client in a failed one.
export async function inRawTenant<T>(
  client: pg.ClientBase,
  context: RawContext,
  work: () => Promise<T>,
  end: 'commit' | 'rollback' = 'rollback',
): Promise<T> {
  await client.query('begin');
  try {
    await client.query(
      `select set_config('ujira.principal_id', $1, true),
              set_config('ujira.project_id', $2, true),
              set_config('ujira.scope', $3, true),
              set_config('ujira.txid', txid_current()::text, true)`,
      [context.principalId, context.projectId, context.scope ?? 'project'],
    );
    const result = await work();
    await client.query(end);
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export interface QueuedJob {
  readonly id: string;
  readonly task_identifier: string;
  readonly payload: Record<string, unknown>;
  readonly queue_name: string | null;
  readonly key: string | null;
  readonly run_at: Date;
  readonly max_attempts: number;
}

// The app role cannot read these, so a test asks through the superuser's client.
// The worker's public view leaves the payload out.
export async function queuedJobs(admin: pg.ClientBase): Promise<QueuedJob[]> {
  const result = await admin.query<QueuedJob>(
    `select j.id, t.identifier as task_identifier, j.payload, q.queue_name, j.key, j.run_at,
            j.max_attempts
       from graphile_worker._private_jobs as j
       join graphile_worker._private_tasks as t on t.id = j.task_id
       left join graphile_worker._private_job_queues as q on q.id = j.job_queue_id
      order by j.id`,
  );
  return result.rows;
}
