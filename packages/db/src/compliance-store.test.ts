// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The compliance store against real Postgres, as the real roles.
 *
 * - No job is stranded: a park racing a clear either parks before the clear and is
 *   resumed by it, or finds the mark gone and does not park.
 * - A crash loses nothing: the mark and its notice commit together or not at all.
 * - A replay notifies once, and parking twice keeps one row, by a unique constraint.
 * - One tenant can neither see nor change another's marks, parked jobs or notices.
 */

import { randomUUID } from 'node:crypto';

import type { ComplianceNotice, ComplianceStore, InstanceKey } from '@ujira/mandates';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createComplianceStore } from './compliance-store.js';
import type { Database } from './database.js';
import { compliance } from './repositories/compliance.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { payoutFixture, type PayoutFixture } from './testing/payout-fixture.js';

type Uuid = InstanceKey['principalId'];

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const OPTS = { signal: new AbortController().signal };
const SINCE = new Date('2026-11-01T00:00:00.000Z');
const MARK = { reason: 'principal_key_risk', since: SINCE } as const;

let database: TestDatabase;
let db: Database;
let admin: pg.Client;
let store: ComplianceStore;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  db = databaseAsServiceRoles(roleUrls, database, 8);
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
  store = createComplianceStore({ db });
});

afterAll(async () => {
  await admin.end();
  await db.close();
  await database.drop();
});

function keyOf(fixture: PayoutFixture): InstanceKey {
  return {
    principalId: fixture.tenant.principalId as Uuid,
    projectId: fixture.tenant.projectId as Uuid,
    instanceId: fixture.instanceId,
  };
}

function noticeOf(key: InstanceKey, to: ComplianceNotice['to']): ComplianceNotice {
  return {
    key,
    to,
    at: new Date(),
    fixes: to === 'noncompliant' ? ['lower_budget', 'add_approval_threshold'] : [],
  } as unknown as ComplianceNotice;
}

const markIt = (key: InstanceKey) =>
  store.applyMark(key, MARK, noticeOf(key, 'noncompliant'), OPTS);
const clearIt = (key: InstanceKey) => store.applyMark(key, null, noticeOf(key, 'compliant'), OPTS);

async function stateOf(fixture: PayoutFixture) {
  return db.tenant(fixture.tenant).transaction(async (tx) => ({
    mark: await compliance.mark(tx, fixture.instanceId),
    parked: await compliance.parkedJobs(tx, fixture.instanceId),
    notices: await compliance.notices(tx, fixture.instanceId),
  }));
}

describe('the mark', () => {
  it('reads as set once set, with its reason and since, and as nothing once cleared', async () => {
    const fixture = await payoutFixture(db);
    const key = keyOf(fixture);
    expect(await store.read(key, OPTS)).toBeNull();
    expect(await markIt(key)).toBe(true);
    expect(await store.read(key, OPTS)).toEqual(MARK);
    expect(await clearIt(key)).toBe(true);
    expect(await store.read(key, OPTS)).toBeNull();
  });

  it('writes the notice with the mark, carrying the fixes', async () => {
    const fixture = await payoutFixture(db);
    const key = keyOf(fixture);
    await markIt(key);
    await clearIt(key);
    const { notices } = await stateOf(fixture);
    expect(notices.map((n) => [n.to, n.fixes])).toEqual([
      ['noncompliant', ['lower_budget', 'add_approval_threshold']],
      ['compliant', []],
    ]);
  });

  it('a replay notifies once', async () => {
    const fixture = await payoutFixture(db);
    const key = keyOf(fixture);
    expect(await markIt(key)).toBe(true);
    expect(await markIt(key)).toBe(false);
    expect(await clearIt(key)).toBe(true);
    expect(await clearIt(key)).toBe(false);
    expect((await stateOf(fixture)).notices).toHaveLength(2);
  });

  it('notifies once however many replays race', async () => {
    const fixture = await payoutFixture(db);
    const key = keyOf(fixture);
    const changed = await Promise.all(Array.from({ length: 20 }, () => markIt(key)));
    expect(changed.filter(Boolean)).toHaveLength(1);
    expect((await stateOf(fixture)).notices).toHaveLength(1);
  });

  it('a crash loses nothing: a failed transaction leaves neither the mark nor its notice', async () => {
    const fixture = await payoutFixture(db);
    const killed = new Error('worker killed');
    await expect(
      db.tenant(fixture.tenant).transaction(async (tx) => {
        await compliance.applyMark(tx, fixture.instanceId, MARK, {
          to: 'noncompliant',
          at: new Date(),
          fixes: [],
        });
        throw killed;
      }),
    ).rejects.toBe(killed);
    const { mark, notices } = await stateOf(fixture);
    expect(mark).toBeUndefined();
    expect(notices).toEqual([]);
  });

  it('a crash in the middle of a clear leaves the mark and its parked jobs as they were', async () => {
    const fixture = await payoutFixture(db);
    const key = keyOf(fixture);
    await markIt(key);
    await store.parkIfNoncompliant(key, 'job-1', OPTS);
    const killed = new Error('worker killed');
    await expect(
      db.tenant(fixture.tenant).transaction(async (tx) => {
        await compliance.applyMark(tx, fixture.instanceId, null, {
          to: 'compliant',
          at: new Date(),
          fixes: [],
        });
        throw killed;
      }),
    ).rejects.toBe(killed);
    const { mark, parked, notices } = await stateOf(fixture);
    expect(mark).toBeDefined();
    expect(parked.map((p) => p.status)).toEqual(['parked']);
    expect(notices).toHaveLength(1);
  });
});

describe('parking', () => {
  it('parks only on a marked instance, and the clear resumes what it parked', async () => {
    const fixture = await payoutFixture(db);
    const key = keyOf(fixture);
    expect(await store.parkIfNoncompliant(key, 'job-1', OPTS)).toBe(false);
    await markIt(key);
    expect(await store.parkIfNoncompliant(key, 'job-1', OPTS)).toBe(true);
    expect(await store.parkIfNoncompliant(key, 'job-2', OPTS)).toBe(true);
    await clearIt(key);
    const { parked } = await stateOf(fixture);
    expect(parked.map((p) => [p.jobId, p.status])).toEqual([
      ['job-1', 'resumed'],
      ['job-2', 'resumed'],
    ]);
    expect(parked.every((p) => p.resumedAt !== null)).toBe(true);
  });

  it('parking twice keeps one row', async () => {
    const fixture = await payoutFixture(db);
    const key = keyOf(fixture);
    await markIt(key);
    await Promise.all(
      Array.from({ length: 10 }, () => store.parkIfNoncompliant(key, 'job-1', OPTS)),
    );
    expect((await stateOf(fixture)).parked).toHaveLength(1);
    await expect(
      admin.query(
        `insert into ujira.compliance_parked_jobs
           (principal_id, project_id, mandate_instance_id, job_id) values ($1, $2, $3, 'job-1')`,
        [fixture.tenant.principalId, fixture.tenant.projectId, fixture.instanceId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('parks a resumed job again, in its one row, when the instance is marked again', async () => {
    const fixture = await payoutFixture(db);
    const key = keyOf(fixture);
    await markIt(key);
    await store.parkIfNoncompliant(key, 'job-1', OPTS);
    await clearIt(key);
    await markIt(key);
    await store.parkIfNoncompliant(key, 'job-1', OPTS);
    const { parked } = await stateOf(fixture);
    expect(parked.map((p) => [p.jobId, p.status, p.resumedAt])).toEqual([
      ['job-1', 'parked', null],
    ]);
  });

  it('no job is stranded however parks and clears race', async () => {
    const fixture = await payoutFixture(db);
    const key = keyOf(fixture);
    for (let round = 0; round < 40; round += 1) {
      await markIt(key);
      const jobs = Array.from({ length: 4 }, () => `job-${randomUUID()}`);
      await Promise.all([
        ...jobs.map((job) => store.parkIfNoncompliant(key, job, OPTS)),
        clearIt(key),
      ]);
      const { mark, parked } = await stateOf(fixture);
      expect(mark).toBeUndefined();
      expect(parked.filter((p) => p.status === 'parked')).toEqual([]);
    }
    const { rows } = await admin.query<{ count: string }>(
      `select count(*) from ujira.compliance_parked_jobs as j
        where j.status = 'parked'
          and not exists (
            select 1 from ujira.compliance_marks as m
             where m.principal_id = j.principal_id and m.project_id = j.project_id
               and m.mandate_instance_id = j.mandate_instance_id)`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('refuses a job on an instance the tenant does not have', async () => {
    const fixture = await payoutFixture(db);
    await expect(
      db.tenant(fixture.tenant).transaction((tx) =>
        sql`insert into ujira.compliance_marks (principal_id, project_id, mandate_instance_id, reason, since)
              values (ujira.current_principal_id(), ujira.current_project_id(), ${randomUUID()}, 'principal_key_risk', now())`.execute(
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('isolation', () => {
  it('cross tenant access is impossible', async () => {
    const owner = await payoutFixture(db);
    const other = await payoutFixture(db);
    const ownerKey = keyOf(owner);
    await markIt(ownerKey);
    await store.parkIfNoncompliant(ownerKey, 'job-1', OPTS);

    // Another tenant naming the owner's instance in its own session sees nothing.
    const stolen = { ...keyOf(other), instanceId: owner.instanceId };
    expect(await store.read(stolen, OPTS)).toBeNull();
    expect(await store.parkIfNoncompliant(stolen, 'job-2', OPTS)).toBe(false);
    await expect(store.applyMark(stolen, null, noticeOf(stolen, 'compliant'), OPTS)).resolves.toBe(
      false,
    );
    await expect(
      store.applyMark(stolen, MARK, noticeOf(stolen, 'noncompliant'), OPTS),
    ).rejects.toMatchObject({ code: '23503' });

    const { mark, parked, notices } = await stateOf(owner);
    expect(mark).toBeDefined();
    expect(parked.map((p) => [p.jobId, p.status])).toEqual([['job-1', 'parked']]);
    expect(notices).toHaveLength(1);
    expect(
      await db.tenant(other.tenant).transaction(async (tx) => ({
        parked: await compliance.parkedJobs(tx, owner.instanceId),
        notices: await compliance.notices(tx, owner.instanceId),
      })),
    ).toEqual({ parked: [], notices: [] });
  });

  it('asks the signal before opening anything', async () => {
    const fixture = await payoutFixture(db);
    const key = keyOf(fixture);
    const controller = new AbortController();
    controller.abort();
    const opts = { signal: controller.signal };
    for (const call of [
      () => store.read(key, opts),
      () => store.applyMark(key, MARK, noticeOf(key, 'noncompliant'), opts),
      () => store.parkIfNoncompliant(key, 'job-1', opts),
    ]) {
      await expect(call()).rejects.toThrow();
    }
    expect((await stateOf(fixture)).notices).toEqual([]);
  });
});
