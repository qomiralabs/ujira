// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { JobHelpers, Task } from 'graphile-worker';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  enqueue,
  jobPayload,
  sleep,
  startSpikeDb,
  startWorker,
  TENANT_A,
  TENANT_B,
  tenantTx,
  waitFor,
  type SpikeDb,
  type Tenant,
} from './harness.js';

let db: SpikeDb;
let app: pg.Pool;
let workerSql: pg.Pool;

interface JobRow {
  id: string;
  task_identifier: string;
  queue_name: string | null;
  key: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  last_error: string | null;
  delay_ms: number;
}

async function jobs(pool: pg.Pool = workerSql): Promise<JobRow[]> {
  const result = await pool.query<JobRow>(
    `select j.id::text, j.task_identifier, j.queue_name, j.key, p.payload, j.attempts,
            j.max_attempts, j.locked_by, j.last_error,
            (extract(epoch from j.run_at - now()) * 1000)::int as delay_ms
       from graphile_worker.jobs j
       join graphile_worker._private_jobs p using (id)
      order by j.id`,
  );
  return result.rows;
}

function sqlState(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function insertPayout(client: pg.PoolClient, tenant: Tenant): Promise<string> {
  const result = await client.query<{ id: string }>(
    'insert into ujira.payouts (principal_id, project_id) values ($1, $2) returning id',
    [tenant.principalId, tenant.projectId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('insert returned no row');
  return row.id;
}

beforeAll(async () => {
  db = await startSpikeDb();
  app = new pg.Pool({ connectionString: db.url('ujira_app'), max: 10 });
  workerSql = new pg.Pool({ connectionString: db.url('ujira_worker'), max: 2 });
});

afterAll(async () => {
  await app.end();
  await workerSql.end();
  await db.close();
});

beforeEach(async () => {
  await workerSql.query('delete from graphile_worker._private_jobs');
  await workerSql.query('delete from graphile_worker._private_job_queues');
});

describe('enqueue from the app role', () => {
  it('rolled back transaction leaves no job', async () => {
    let jobId: string | undefined;
    await expect(
      tenantTx(app, TENANT_A, async (client) => {
        await insertPayout(client, TENANT_A);
        jobId = await enqueue(client, 'payout:advance', { payoutId: 'p-rolled-back' });
        throw new Error('write failed after enqueue');
      }),
    ).rejects.toThrow('write failed after enqueue');

    expect(jobId).toBeDefined();
    expect(await jobs()).toEqual([]);
  });

  it('app role adds a job inside a tenant transaction', async () => {
    const roles = await workerSql.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = 'ujira_app'",
    );
    expect(roles.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const rls = await workerSql.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relrowsecurity, relforcerowsecurity from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'ujira' and c.relname = 'payouts'`,
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    // The worker pool's role owns the queue and nothing else.
    const workerReach = await workerSql.query<{ usage: boolean }>(
      "select has_schema_privilege('ujira_worker', 'ujira', 'USAGE') as usage",
    );
    expect(workerReach.rows).toEqual([{ usage: false }]);

    const { payoutId, visibleBeforeCommit } = await tenantTx(app, TENANT_A, async (client) => {
      const id = await insertPayout(client, TENANT_A);
      await enqueue(
        client,
        'payout:advance',
        { payoutId: id },
        { jobKey: `payout:${id}:advance`, queue: 'mandate:m1' },
      );
      return { payoutId: id, visibleBeforeCommit: (await jobs()).length };
    });

    expect(visibleBeforeCommit).toBe(0);
    const prefix = `${TENANT_A.principalId}:${TENANT_A.projectId}:`;
    const [job, ...rest] = await jobs();
    expect(rest).toEqual([]);
    expect(job).toMatchObject({
      task_identifier: 'payout:advance',
      queue_name: `${prefix}mandate:m1`,
      key: `${prefix}payout:${payoutId}:advance`,
      payload: { payoutId, ...TENANT_A },
    });
  });

  it('app role cannot reach graphile_worker directly', async () => {
    const direct = tenantTx(app, TENANT_A, (client) =>
      client.query("select graphile_worker.add_job('payout:advance', '{}')"),
    );
    await expect(direct).rejects.toThrow('permission denied for schema graphile_worker');
    await expect(app.query('select count(*) from graphile_worker.jobs')).rejects.toThrow(
      'permission denied',
    );
  });

  it('enqueue refuses a job without a single project context', async () => {
    const noContext = app.query("select ujira_jobs.enqueue('payout:advance', '{}')");
    await expect(noContext).rejects.toSatisfy((e) => sqlState(e) === 'UJ001');

    const allProjects = tenantTx(app, { ...TENANT_A, projectId: 'all' }, (client) =>
      enqueue(client, 'payout:advance', {}),
    );
    await expect(allProjects).rejects.toThrow('jobs need a single project scope');

    const forged = tenantTx(app, TENANT_A, (client) =>
      enqueue(client, 'payout:advance', { principalId: TENANT_B.principalId }),
    );
    await expect(forged).rejects.toThrow('without tenant ids');
    expect(await jobs()).toEqual([]);
  });

  it('enqueue stores the tenant in canonical form', async () => {
    const shouted = {
      principalId: TENANT_A.principalId.toUpperCase(),
      projectId: TENANT_A.projectId.toUpperCase(),
    };
    await tenantTx(app, shouted, (client) =>
      enqueue(client, 'payout:advance', { payoutId: 'p1' }, { jobKey: 'k' }),
    );
    expect(await jobs()).toMatchObject([
      {
        key: `${TENANT_A.principalId}:${TENANT_A.projectId}:k`,
        payload: { payoutId: 'p1', ...TENANT_A },
      },
    ]);

    const garbled = tenantTx(app, { ...TENANT_A, principalId: 'not-a-uuid' }, (client) =>
      enqueue(client, 'payout:advance', {}),
    );
    await expect(garbled).rejects.toThrow('tenant context is not a uuid');
  });

  it('the same job key from two tenants makes two jobs', async () => {
    for (const tenant of [TENANT_A, TENANT_B]) {
      await tenantTx(app, tenant, (client) =>
        enqueue(client, 'payout:advance', { payoutId: 'same' }, { jobKey: 'payout:same:advance' }),
      );
    }
    const rows = await jobs();
    expect(rows.map((r) => r.payload['principalId'])).toEqual([
      TENANT_A.principalId,
      TENANT_B.principalId,
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
});

describe('enqueue argument checks', () => {
  // Positional, so a test can hand SQL a real NULL for any one argument.
  const ARGS = ['task', 'ids', 'jobKey', 'queue', 'runAt', 'maxAttempts', 'keyMode'] as const;
  type Arg = (typeof ARGS)[number];
  const valid: Record<Arg, unknown> = {
    task: 'payout:advance',
    ids: JSON.stringify({ payoutId: 'p1' }),
    jobKey: 'payout:p1:advance',
    queue: 'mandate:m1',
    runAt: null,
    maxAttempts: 5,
    keyMode: 'replace',
  };

  function call(overrides: Partial<Record<Arg, unknown>>): Promise<unknown> {
    const values = ARGS.map((arg) => (arg in overrides ? overrides[arg] : valid[arg]));
    return tenantTx(app, TENANT_A, (client) =>
      client.query(
        'select ujira_jobs.enqueue($1, $2::jsonb, $3, $4, $5::timestamptz, $6::integer, $7)',
        values,
      ),
    );
  }

  it.each([
    ['task', 'task is required'],
    ['ids', 'ids are required'],
    ['keyMode', 'key mode is required'],
  ] as const)('a null %s is refused before anything is written', async (arg, message) => {
    const result = call({ [arg]: null });
    await expect(result).rejects.toThrow(message);
    await expect(result).rejects.toSatisfy((e) => sqlState(e) === '22004');
    expect(await jobs()).toEqual([]);
  });

  it('a json null for ids is refused like any other non object', async () => {
    await expect(call({ ids: 'null' })).rejects.toThrow('job payload must be string ids');
    expect(await jobs()).toEqual([]);
  });

  it('a null job key means no key', async () => {
    await call({ jobKey: null });
    expect(await jobs()).toMatchObject([{ key: null }]);
  });

  it('a null queue means no queue', async () => {
    await call({ queue: null });
    expect(await jobs()).toMatchObject([{ queue_name: null }]);
  });

  it('a null run at means now', async () => {
    await call({ runAt: null });
    const [job] = await jobs();
    expect(job?.delay_ms).toBeLessThanOrEqual(0);
    expect(job?.delay_ms).toBeGreaterThan(-5000);
  });

  it('a null max attempts means the worker default', async () => {
    await call({ maxAttempts: null });
    expect(await jobs()).toMatchObject([{ max_attempts: 25 }]);
  });

  it.each([
    ['jobKey', '', 'job key must not be empty'],
    ['queue', '', 'queue must not be empty'],
    ['maxAttempts', 0, 'max attempts must be between 1 and 100'],
    ['maxAttempts', 101, 'max attempts must be between 1 and 100'],
    ['keyMode', 'unsafe_dedupe', 'unsupported job key mode'],
    ['task', 'payout.advance', 'invalid task identifier'],
  ] as const)('%s %j is refused', async (arg, value, message) => {
    await expect(call({ [arg]: value })).rejects.toThrow(message);
    expect(await jobs()).toEqual([]);
  });
});

describe('running jobs', () => {
  it('two jobs on one queue never run concurrently', async () => {
    const perQueue = 15;
    const queues = ['mandate:m1', 'mandate:m2', 'mandate:m3'];
    for (const [q, queue] of queues.entries()) {
      const tenant = q % 2 === 0 ? TENANT_A : TENANT_B;
      await tenantTx(app, tenant, async (client) => {
        for (let i = 0; i < perQueue; i++) {
          await enqueue(client, 'mandate:step', { queue, seq: String(i) }, { queue });
        }
      });
    }

    const running = new Map<string, number>();
    const maxRunning = new Map<string, number>();
    const order = new Map<string, number[]>();
    let overall = 0;
    let overallMax = 0;
    let done = 0;
    let wrongTenant = 0;
    const step: Task = async (raw) => {
      const payload = jobPayload.parse(raw);
      const queue = payload['queue'] ?? '';
      running.set(queue, (running.get(queue) ?? 0) + 1);
      maxRunning.set(queue, Math.max(maxRunning.get(queue) ?? 0, running.get(queue) ?? 0));
      overall++;
      overallMax = Math.max(overallMax, overall);
      // The handler gets its tenant from the payload and must see only that tenant's rows.
      const seen = await tenantTx(app, payload, (client) =>
        client.query<{ principal_id: string }>('select principal_id from ujira.payouts'),
      );
      if (seen.rows.some((r) => r.principal_id !== payload.principalId)) wrongTenant++;
      await sleep(15);
      order.set(queue, [...(order.get(queue) ?? []), Number(payload['seq'])]);
      running.set(queue, (running.get(queue) ?? 1) - 1);
      overall--;
      done++;
    };

    const runner = await startWorker(db, { 'mandate:step': step }, 8);
    try {
      await waitFor(() => done === perQueue * queues.length, 30000);
    } finally {
      await runner.stop();
    }

    expect([...maxRunning.values()]).toEqual([1, 1, 1]);
    // Concurrency was available: the three queues did run side by side.
    expect(overallMax).toBeGreaterThan(1);
    const expected = Array.from({ length: perQueue }, (_, i) => i);
    for (const queue of queues) expect(order.get(queue)).toEqual(expected);
    expect(wrongTenant).toBe(0);
  });

  it('stopping mid job still records the completion', async () => {
    await tenantTx(app, TENANT_A, (client) => enqueue(client, 'slow:step', { payoutId: 'p1' }));
    let started = false;
    let finished = false;
    const runner = await startWorker(db, {
      'slow:step': async () => {
        started = true;
        await sleep(500);
        finished = true;
      },
    });
    await waitFor(() => started);
    await runner.stop();

    expect(finished).toBe(true);
    expect(await jobs()).toEqual([]);
  });

  it('a crashed worker holds its queue until force unlocked', async () => {
    await tenantTx(app, TENANT_A, async (client) => {
      await enqueue(client, 'mandate:step', { seq: '0' }, { queue: 'mandate:m1' });
      await enqueue(client, 'mandate:step', { seq: '1' }, { queue: 'mandate:m1' });
    });
    // What a killed process leaves behind: its job and its queue still locked.
    const [first] = await jobs();
    await workerSql.query(
      "update graphile_worker._private_jobs set locked_by = 'pool-dead', locked_at = now(), attempts = 1 where id = $1",
      [first?.id],
    );
    await workerSql.query(
      "update graphile_worker._private_job_queues set locked_by = 'pool-dead', locked_at = now()",
    );

    const ran: string[] = [];
    const runner = await startWorker(db, {
      'mandate:step': (raw) => {
        ran.push(jobPayload.parse(raw)['seq'] ?? '');
      },
    });
    try {
      await sleep(1500);
      expect(ran).toEqual([]);
      await workerSql.query("select graphile_worker.force_unlock_workers(array['pool-dead'])");
      await waitFor(() => ran.length === 2);
    } finally {
      await runner.stop();
    }
    expect(ran).toEqual(['0', '1']);
  });

  it('failed jobs back off by e to the attempts and stop at max attempts', async () => {
    await tenantTx(app, TENANT_A, (client) =>
      enqueue(client, 'chain:call', { payoutId: 'p1' }, { maxAttempts: 2 }),
    );
    let runs = 0;
    const runner = await startWorker(db, {
      'chain:call': () => {
        runs++;
        throw new Error('RPC_TIMEOUT');
      },
    });
    try {
      // A claim sets attempts and locked_by together and a failure clears the
      // lock, so this only matches once the first failure is written.
      let last: JobRow | undefined;
      const failedAfter = async (attempts: number): Promise<boolean> => {
        [last] = await jobs();
        return last?.attempts === attempts && last.locked_by === null;
      };
      // Each try is a claim, a throw and a write; ten seconds is generous on a
      // loaded runner and still fails fast enough to say which try stalled.
      const stalled = (attempts: number) => () =>
        `failure ${String(attempts)} of chain:call to be recorded (runs ${String(runs)}, last row ${JSON.stringify(last ?? null)})`;
      await waitFor(() => failedAfter(1), 10000, stalled(1));
      const [afterFirst] = await jobs();
      // exp(1) seconds, less the time it took to read it back. The next step
      // of the curve is exp(2), so these bounds tell the two apart.
      expect(afterFirst?.delay_ms).toBeGreaterThan(1500);
      expect(afterFirst?.delay_ms).toBeLessThanOrEqual(2719);

      await workerSql.query(
        'select graphile_worker.reschedule_jobs(array[$1::bigint], run_at => now())',
        [afterFirst?.id],
      );
      await waitFor(() => failedAfter(2), 10000, stalled(2));
      // At max attempts the job is the dead letter set: due, never claimed again.
      await workerSql.query('update graphile_worker._private_jobs set run_at = now()');
      await sleep(1000);
    } finally {
      await runner.stop();
    }
    expect(runs).toBe(2);
    expect(await jobs()).toMatchObject([
      { attempts: 2, max_attempts: 2, last_error: 'RPC_TIMEOUT' },
    ]);
  });

  it('a handler can own its backoff by replacing itself under the same key', async () => {
    await tenantTx(app, TENANT_A, (client) =>
      enqueue(
        client,
        'payout:advance',
        { payoutId: 'p1', n: '1' },
        { jobKey: 'payout:p1:advance' },
      ),
    );
    const seenJobs: string[] = [];
    const advance: Task = async (raw, helpers: JobHelpers) => {
      const payload = jobPayload.parse(raw);
      seenJobs.push(helpers.job.id);
      // A retryable chain error: schedule the next try on our own curve, then finish cleanly.
      await tenantTx(app, payload, (client) =>
        enqueue(
          client,
          'payout:advance',
          { payoutId: payload['payoutId'] ?? '', n: '2' },
          { jobKey: 'payout:p1:advance', runAt: new Date(Date.now() + 5000) },
        ),
      );
    };
    const runner = await startWorker(db, { 'payout:advance': advance });
    try {
      await waitFor(async () => {
        const rows = await jobs();
        return rows.length === 1 && rows[0]?.locked_by === null && rows[0].payload['n'] === '2';
      });
    } finally {
      await runner.stop();
    }
    const [next, ...rest] = await jobs();
    expect(rest).toEqual([]);
    expect(next?.id).not.toBe(seenJobs[0]);
    expect(next?.attempts).toBe(0);
    expect(next?.delay_ms).toBeGreaterThan(4000);
    expect(next?.delay_ms).toBeLessThanOrEqual(5000);
  });
});

describe('backup and restore', () => {
  // Stands in for the chain: a database restore cannot roll it back, and it
  // refuses a second payment with the same payout id.
  class FakeChain {
    readonly payments = new Map<string, string>();
    submissions = 0;
    lookup(payoutId: string): string | undefined {
      return this.payments.get(payoutId);
    }
    submit(payoutId: string): string {
      this.submissions++;
      const existing = this.payments.get(payoutId);
      if (existing !== undefined) return existing;
      const tx = `tx-${String(this.payments.size + 1)}`;
      this.payments.set(payoutId, tx);
      return tx;
    }
  }

  function advanceTask(pool: () => pg.Pool, chain: FakeChain, reconciled: string[]): Task {
    return async (raw) => {
      const payload = jobPayload.parse(raw);
      const payoutId = payload['payoutId'] ?? '';
      const status = await tenantTx(pool(), payload, (client) =>
        client.query<{ status: string }>('select status from ujira.payouts where id = $1', [
          payoutId,
        ]),
      );
      if (status.rows[0]?.status !== 'queued') return;
      // Never call out inside the transaction, and ask the chain before paying:
      // after a restore the database can be behind it.
      let tx = chain.lookup(payoutId);
      if (tx === undefined) tx = chain.submit(payoutId);
      else reconciled.push(payoutId);
      await tenantTx(pool(), payload, (client) =>
        client.query(
          "update ujira.payouts set status = 'submitted', tx_ref = $2 where id = $1 and status = 'queued'",
          [payoutId, tx],
        ),
      );
    };
  }

  async function submittedCount(pool: pg.Pool): Promise<number> {
    const result = await tenantTx(pool, TENANT_A, (client) =>
      client.query<{ n: number }>(
        "select count(*)::int as n from ujira.payouts where status = 'submitted'",
      ),
    );
    return result.rows[0]?.n ?? -1;
  }

  async function execOk(command: string[]): Promise<void> {
    const result = await db.container.exec(command);
    if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed: ${result.output}`);
  }

  it('restored jobs are safe', async () => {
    const payoutIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      payoutIds.push(
        await tenantTx(app, TENANT_A, async (client) => {
          const id = await insertPayout(client, TENANT_A);
          await enqueue(
            client,
            'payout:advance',
            { payoutId: id },
            { jobKey: `payout:${id}:advance`, queue: 'mandate:m1' },
          );
          return id;
        }),
      );
    }

    const user = db.container.getUsername();
    await execOk(['pg_dump', '-U', user, '-Fc', '-f', '/tmp/spike.dump', 'ujira']);

    const chain = new FakeChain();
    const reconciled: string[] = [];
    let current = app;
    const first = await startWorker(db, {
      'payout:advance': advanceTask(() => current, chain, reconciled),
    });
    try {
      await waitFor(async () => (await submittedCount(app)) === 3);
    } finally {
      await first.stop();
    }
    expect(chain.payments.size).toBe(3);
    expect(chain.submissions).toBe(3);

    await execOk(['psql', '-U', user, '-d', 'postgres', '-c', 'create database ujira_restored']);
    await execOk([
      'pg_restore',
      '-U',
      user,
      '--exit-on-error',
      '-d',
      'ujira_restored',
      '/tmp/spike.dump',
    ]);
    const restoredApp = new pg.Pool({
      connectionString: db.url('ujira_app', 'ujira_restored'),
      max: 4,
    });
    const restoredWorker = new pg.Pool({
      connectionString: db.url('ujira_worker', 'ujira_restored'),
      max: 2,
    });
    current = restoredApp;
    try {
      // The restore brings back every job that had already run, and the payouts as unpaid.
      expect((await jobs(restoredWorker)).length).toBe(3);
      expect(await submittedCount(restoredApp)).toBe(0);

      const second = await startWorker(
        db,
        { 'payout:advance': advanceTask(() => current, chain, reconciled) },
        4,
        'ujira_restored',
      );
      try {
        await waitFor(async () => (await jobs(restoredWorker)).length === 0);
      } finally {
        await second.stop();
      }

      expect(await submittedCount(restoredApp)).toBe(3);
      expect(chain.payments.size).toBe(3);
      expect(chain.submissions).toBe(3);
      expect(reconciled.sort()).toEqual([...payoutIds].sort());
    } finally {
      await restoredApp.end();
      await restoredWorker.end();
    }
  });
});
