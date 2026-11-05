// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// An IF on NULL is false, so a check written as a plain comparison lets a NULL
// straight through. An earlier version of this function stored a job with no
// tenant that way. One test per argument, each proving an error and no job.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { inRawTenant, queuedJobs } from './testing/jobs-fixture.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');

const TENANT = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
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

afterAll(async () => {
  await app.end();
  await admin.end();
  await database.drop();
});

const ARGUMENTS: readonly (readonly [string, string])[] = [
  ['p_task', `null, '{}'::jsonb`],
  ['p_ids', `'payout:advance', null`],
  ['p_job_key', `'payout:advance', '{}'::jsonb, p_job_key => null`],
  ['p_queue', `'payout:advance', '{}'::jsonb, p_queue => null`],
  ['p_run_at', `'payout:advance', '{}'::jsonb, p_run_at => null`],
  ['p_max_attempts', `'payout:advance', '{}'::jsonb, p_max_attempts => null`],
  ['p_key_mode', `'payout:advance', '{}'::jsonb, p_key_mode => null`],
  ['p_scope', `'payout:advance', '{}'::jsonb, p_scope => null`],
];

describe('enqueue refuses NULL', () => {
  it.each(ARGUMENTS)('%s', async (name, statement) => {
    const refused = inRawTenant(
      app,
      TENANT,
      () => app.query(`select ujira_jobs.enqueue(${statement})`),
      'commit',
    );
    await expect(refused).rejects.toMatchObject({
      code: '22004',
      message: expect.stringContaining(name) as string,
    });
    expect(await queuedJobs(admin)).toEqual([]);
  });

  // Refusing NULL must come first, or a NULL would be read as a missing tenant
  // or a bad name and the message would send someone the wrong way.
  it('says which argument, even with no tenant context', async () => {
    await expect(app.query(`select ujira_jobs.enqueue(null, '{}'::jsonb)`)).rejects.toMatchObject({
      code: '22004',
    });
  });
});
