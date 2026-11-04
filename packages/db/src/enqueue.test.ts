// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// ujira_jobs.enqueue as the app login sees it, against the installed worker
// schema. The tenant settings are written by hand here, because several of these
// tests give the database a context the repository would refuse to send.

import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { inRawTenant, queuedJobs } from './testing/jobs-fixture.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const A = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
};
const A2 = { principalId: A.principalId, projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f05' };
const B = {
  principalId: '0199a1f6-9999-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-9999-7a55-8e21-5b9c7d3e1f04',
};

let database: TestDatabase;
let admin: pg.Client;
let app: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  app = new pg.Client({ connectionString: roleUrl(roleUrls, 'ujira_app', database.name) });
  await app.connect();
});

afterEach(async () => {
  await admin.query('delete from graphile_worker._private_jobs');
});

afterAll(async () => {
  await app.end();
  await admin.end();
  await database.drop();
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const enqueue = async (statement: string, values: unknown[] = []): Promise<unknown> =>
  app.query(`select ujira_jobs.enqueue(${statement})`, values);

const IDS = `'{"payoutId": "p1"}'::jsonb`;

describe('jobs follow the write', () => {
  it('rolled back transaction leaves no job', async () => {
    await inRawTenant(app, A, () => enqueue(`'payout:advance', ${IDS}`), 'rollback');
    expect(await queuedJobs(admin)).toEqual([]);
  });

  it('a committed transaction leaves one', async () => {
    await inRawTenant(app, A, () => enqueue(`'payout:advance', ${IDS}`), 'commit');
    expect(await queuedJobs(admin)).toHaveLength(1);
  });

  it('jobs of one transaction get distinct, increasing run times', async () => {
    await inRawTenant(
      app,
      A,
      async () => {
        await enqueue(`'payout:advance', ${IDS}`);
        await enqueue(`'payout:advance', ${IDS}`);
        await enqueue(`'payout:advance', ${IDS}`);
      },
      'commit',
    );
    const times = await admin.query<{ at: string }>(
      `select run_at::text as at from graphile_worker._private_jobs order by id`,
    );
    const at = times.rows.map((row) => row.at);
    expect(new Set(at).size).toBe(3);
    expect([...at].sort()).toEqual(at);
  });
});

describe('the tenant comes from the transaction', () => {
  it('payload tenant ids equal the transaction context', async () => {
    await inRawTenant(app, A, () => enqueue(`'payout:advance', ${IDS}`), 'commit');
    const [job] = await queuedJobs(admin);
    expect(job?.payload).toEqual({
      payoutId: 'p1',
      principalId: A.principalId,
      projectId: A.projectId,
    });
  });

  it.each(['principalId', 'projectId'])('ids named %s are refused', async (name) => {
    const code = await codeOf(
      inRawTenant(app, A, () =>
        enqueue(`'payout:advance', $1::jsonb`, [{ [name]: B.principalId }]),
      ),
    );
    expect(code).toBe('22023');
    expect(await queuedJobs(admin)).toEqual([]);
  });

  it('with no context at all it is refused', async () => {
    expect(await codeOf(enqueue(`'payout:advance', ${IDS}`))).toBe('UJ001');
  });

  it('settings left over from another transaction are refused', async () => {
    await app.query(
      `select set_config('ujira.principal_id', $1, false),
              set_config('ujira.project_id', $2, false),
              set_config('ujira.scope', 'project', false),
              set_config('ujira.txid', txid_current()::text, false)`,
      [A.principalId, A.projectId],
    );
    try {
      expect(await codeOf(enqueue(`'payout:advance', ${IDS}`))).toBe('UJ001');
    } finally {
      await app.query(
        `select set_config('ujira.principal_id', '', false),
                set_config('ujira.project_id', '', false),
                set_config('ujira.scope', '', false),
                set_config('ujira.txid', '', false)`,
      );
    }
  });

  it('scope all is refused', async () => {
    const code = await codeOf(
      inRawTenant(app, { ...A, scope: 'all' }, () => enqueue(`'payout:advance', ${IDS}`)),
    );
    expect(code).toBe('UJ001');
  });

  it('an uppercase or braced tenant id in the settings is stored as lowercase hyphenated uuid', async () => {
    await inRawTenant(
      app,
      {
        principalId: `{${A.principalId.toUpperCase()}}`,
        projectId: A.projectId.toUpperCase(),
      },
      () => enqueue(`'payout:advance', ${IDS}, 'one', 'two'`),
      'commit',
    );
    const [job] = await queuedJobs(admin);
    expect(job?.payload).toMatchObject({ principalId: A.principalId, projectId: A.projectId });
    expect(job?.key).toBe(`${A.principalId}:${A.projectId}:one`);
    expect(job?.queue_name).toBe(`${A.principalId}:${A.projectId}:two`);
  });

  it('a tenant setting that is not a uuid is refused', async () => {
    const code = await codeOf(
      inRawTenant(app, { ...A, projectId: 'not-a-uuid' }, () =>
        enqueue(`'payout:advance', ${IDS}`),
      ),
    );
    expect(code).toBe('UJ001');
  });
});

describe('keys and queues are per tenant', () => {
  it('the same key from two tenants makes two jobs', async () => {
    for (const tenant of [A, B]) {
      await inRawTenant(app, tenant, () => enqueue(`'payout:advance', ${IDS}, 'same'`), 'commit');
    }
    const jobs = await queuedJobs(admin);
    expect(jobs.map((job) => job.key)).toEqual([
      `${A.principalId}:${A.projectId}:same`,
      `${B.principalId}:${B.projectId}:same`,
    ]);
    expect(jobs.map((job) => job.payload['principalId'])).toEqual([A.principalId, B.principalId]);
  });

  it('the same key from one tenant replaces the job', async () => {
    for (const payout of ['first', 'second']) {
      await inRawTenant(
        app,
        A,
        () => enqueue(`'payout:advance', $1::jsonb, 'same'`, [{ payoutId: payout }]),
        'commit',
      );
    }
    const jobs = await queuedJobs(admin);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload['payoutId']).toBe('second');
  });

  it('two projects of a principal do not share a project queue', async () => {
    for (const tenant of [A, A2]) {
      await inRawTenant(
        app,
        tenant,
        () => enqueue(`'payout:advance', ${IDS}, p_queue => 'mandate:1'`),
        'commit',
      );
    }
    const names = new Set((await queuedJobs(admin)).map((job) => job.queue_name));
    expect(names.size).toBe(2);
  });

  // The principal key rule's recheck reads everything a principal holds, so it
  // must run one at a time across that principal's projects.
  it('two projects of a principal share a principal queue, and another principal does not', async () => {
    for (const tenant of [A, A2, B]) {
      await inRawTenant(
        app,
        tenant,
        () => enqueue(`'principal:recheck', ${IDS}, p_queue => 'recheck', p_scope => 'principal'`),
        'commit',
      );
    }
    const jobs = await queuedJobs(admin);
    expect(jobs.map((job) => job.queue_name)).toEqual([
      `${A.principalId}:*:recheck`,
      `${A.principalId}:*:recheck`,
      `${B.principalId}:*:recheck`,
    ]);
    // The job still runs under the project that asked for it.
    expect(jobs[1]?.payload['projectId']).toBe(A2.projectId);
  });
});

describe('arguments', () => {
  it.each([
    ['a dotted task', `'payout.advance', ${IDS}`],
    ['a bare task', `'advance', ${IDS}`],
    ['an upper case task', `'Payout:Advance', ${IDS}`],
    ['ids that are an array', `'payout:advance', '[]'::jsonb`],
    ['an id that is a number', `'payout:advance', '{"payoutId": 1}'::jsonb`],
    ['an empty key', `'payout:advance', ${IDS}, ''`],
    ['an empty queue', `'payout:advance', ${IDS}, p_queue => ''`],
    ['a key with a space', `'payout:advance', ${IDS}, 'a b'`],
    ['a queue over the limit', `'payout:advance', ${IDS}, p_queue => repeat('q', 55)`],
    ['zero attempts', `'payout:advance', ${IDS}, p_max_attempts => 0`],
    ['too many attempts', `'payout:advance', ${IDS}, p_max_attempts => 101`],
    ['the dedupe key mode', `'payout:advance', ${IDS}, p_key_mode => 'unsafe_dedupe'`],
    ['an unknown scope', `'payout:advance', ${IDS}, p_scope => 'all'`],
  ])('%s is refused', async (_name, statement) => {
    expect(await codeOf(inRawTenant(app, A, () => enqueue(statement)))).toBe('22023');
  });

  it.each([
    ['infinity run_at is refused', `'infinity'::timestamptz`],
    ['-infinity run_at is refused', `'-infinity'::timestamptz`],
    ['run_at ten years ahead is refused', `clock_timestamp() + interval '10 years'`],
    ['run_at ten years ago is refused', `clock_timestamp() - interval '10 years'`],
  ])('%s', async (_name, runAt) => {
    const code = await codeOf(
      inRawTenant(app, A, () => enqueue(`'payout:advance', ${IDS}, p_run_at => ${runAt}`)),
    );
    expect(code).toBe('22023');
  });

  it('a run time within the year is taken as given', async () => {
    await inRawTenant(
      app,
      A,
      () =>
        enqueue(`'payout:advance', ${IDS}, p_run_at => clock_timestamp() + interval '11 months'`),
      'commit',
    );
    expect(await queuedJobs(admin)).toHaveLength(1);
  });

  it('a queue at the limit fits the worker table with the prefix on it', async () => {
    await inRawTenant(
      app,
      A,
      () => enqueue(`'payout:advance', ${IDS}, p_queue => repeat('q', 54)`),
      'commit',
    );
    expect(await queuedJobs(admin)).toHaveLength(1);
  });

  it('with nothing optional set, it has no key and no queue and five attempts', async () => {
    await inRawTenant(app, A, () => enqueue(`'payout:advance', ${IDS}`), 'commit');
    const [job] = await queuedJobs(admin);
    expect(job?.key).toBeNull();
    expect(job?.queue_name).toBeNull();
    expect(job?.max_attempts).toBe(5);
  });
});

describe('who can call it', () => {
  it('only the app login may execute it', async () => {
    const result = await admin.query<{ rolname: string }>(
      `select r.rolname
         from pg_roles r
        where r.rolname like 'ujira\\_%'
          and r.rolname not in ('ujira_worker', 'ujira_owner')
          and has_function_privilege(
            r.oid,
            'ujira_jobs.enqueue(text, jsonb, text, text, timestamptz, integer, text, text)',
            'EXECUTE'
          )
        order by 1`,
    );
    expect(result.rows.map((row) => row.rolname)).toEqual(['ujira_app']);
  });

  it('is a definer function with a pinned search path, owned by the worker', async () => {
    const result = await admin.query(
      `select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer, p.proconfig as config
         from pg_proc p where p.oid = 'ujira_jobs.enqueue'::regproc`,
    );
    expect(result.rows).toEqual([
      { owner: 'ujira_worker', definer: true, config: ['search_path=pg_catalog, pg_temp'] },
    ]);
  });
});

describe('worker heartbeats', () => {
  it('belong to the worker, and the app cannot read them', async () => {
    const worker = new pg.Client({
      connectionString: roleUrl(roleUrls, 'ujira_worker', database.name),
    });
    await worker.connect();
    try {
      await worker.query(
        `insert into ujira_jobs.worker_heartbeats (worker_id) values ('pool-1')
           on conflict (worker_id) do update set last_seen_at = now()`,
      );
      expect(
        (await worker.query('select worker_id from ujira_jobs.worker_heartbeats')).rows,
      ).toEqual([{ worker_id: 'pool-1' }]);
    } finally {
      await worker.end();
    }
    expect(await codeOf(app.query('select * from ujira_jobs.worker_heartbeats'))).toBe('42501');
  });
});
