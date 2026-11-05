// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The case erasure exists for and a backup undoes. A real pg_dump taken before the
// erasure, restored afterwards, brings back the key, the data and a log that has
// forgotten. The replay works from an export kept outside the backup.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { Database } from './database.js';
import {
  exportErasures,
  parseExportLine,
  replayErasures,
  type ErasedSubject,
} from './erasure-replay.js';
import { LocalKeyManager } from './key-manager/local.js';
import { erasure, SubjectErasedError, subjectKeys } from './repositories/erasure.js';
import { recipientPii } from './repositories/recipients.js';
import { databaseAsServiceRoles } from './testing/databases.js';
import { createTestDatabase, roleUrl, type TestDatabase } from './testing/harness.js';
import { payoutFixture, type PayoutFixture } from './testing/payout-fixture.js';

const adminUrl = inject('dbAdminUrl');
const roleUrls = inject('dbRoleUrls');
const containerId = inject('dbContainerId');

const keyManager = new LocalKeyManager({
  keks: `test-kek:${'cd'.repeat(32)}`,
  nodeEnv: 'test',
});
const NAME = Buffer.from('Ada Example', 'utf8');

const superuser = new URL(adminUrl).username;

let source: TestDatabase;
let restored: TestDatabase;
let db: Database;
let fixture: PayoutFixture;

function inContainer(...command: string[]): void {
  execFileSync('docker', ['exec', containerId, ...command], { stdio: 'pipe' });
}

function dump(database: TestDatabase, file: string): void {
  inContainer('pg_dump', '-U', superuser, '-d', database.name, '-Fc', '-f', file);
}

function restore(file: string, into: TestDatabase): void {
  inContainer('pg_restore', '-U', superuser, '-d', into.name, '--exit-on-error', file);
}

async function asOps<T>(
  database: TestDatabase,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: roleUrl(roleUrls, 'ujira_ops', database.name) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function exported(database: TestDatabase): Promise<ErasedSubject[]> {
  return asOps(database, async (client) => {
    const all: ErasedSubject[] = [];
    for await (const subject of exportErasures(client)) all.push(subject);
    return all;
  });
}

async function storePii() {
  return db.tenant(fixture.tenant).transaction(async (tx) => {
    const value = await subjectKeys.encrypt(tx, keyManager, fixture.recipientId, NAME);
    await recipientPii.put(tx, fixture.recipientId, value);
    return value;
  });
}

async function erase(): Promise<void> {
  await db.tenant(fixture.tenant).transaction(async (tx) => erasure.erase(tx, fixture.recipientId));
}

beforeAll(async () => {
  source = await createTestDatabase(adminUrl, `${import.meta.url}#source`);
  db = databaseAsServiceRoles(roleUrls, source, 4);
});

beforeEach(async () => {
  fixture = await payoutFixture(db);
  restored = await createTestDatabase(adminUrl, `${import.meta.url}#restored`, { empty: true });
});

afterAll(async () => {
  await db.close();
  await source.drop();
  await restored.drop();
});

describe('a restore from before an erasure', () => {
  it('dump, restore and replay re-shreds', async () => {
    const value = await storePii();
    const file = `/tmp/${randomUUID()}.dump`;
    dump(source, file);
    await erase();
    const list = await exported(source);
    expect(list.map((subject) => subject.subjectId)).toContain(fixture.recipientId);

    restore(file, restored);
    const restoredDb = databaseAsServiceRoles(roleUrls, restored, 2);
    try {
      // The danger, shown first: the restore brought the data back, and readable.
      const back = await restoredDb
        .tenant(fixture.tenant)
        .transaction(async (tx) => subjectKeys.decrypt(tx, keyManager, fixture.recipientId, value));
      expect(back).toEqual(NAME);
      // And its own log has no idea, so only the export can say.
      expect((await exported(restored)).map((subject) => subject.subjectId)).not.toContain(
        fixture.recipientId,
      );

      const first = await asOps(restored, async (client) => replayErasures(client, list));
      expect(first.reapplied).toBeGreaterThanOrEqual(1);

      await expect(
        restoredDb
          .tenant(fixture.tenant)
          .transaction(async (tx) =>
            subjectKeys.decrypt(tx, keyManager, fixture.recipientId, value),
          ),
      ).rejects.toBeInstanceOf(SubjectErasedError);
      const stored = await restoredDb
        .tenant(fixture.tenant)
        .transaction(async (tx) => recipientPii.get(tx, fixture.recipientId));
      expect(stored).toBeUndefined();

      // A second run finds nothing to do, and the restored log now remembers.
      const second = await asOps(restored, async (client) => replayErasures(client, list));
      expect(second.reapplied).toBe(0);
      expect((await exported(restored)).map((subject) => subject.subjectId)).toContain(
        fixture.recipientId,
      );
    } finally {
      await restoredDb.close();
      inContainer('rm', '-f', file);
    }
  });

  it('skips a subject the restored database never had', async () => {
    const file = `/tmp/${randomUUID()}.dump`;
    dump(source, file);
    restore(file, restored);
    inContainer('rm', '-f', file);
    const stranger: ErasedSubject = {
      principalId: randomUUID(),
      projectId: randomUUID(),
      subjectId: randomUUID(),
      erasedAt: new Date().toISOString(),
    };
    const result = await asOps(restored, async (client) => replayErasures(client, [stranger]));
    expect(result).toEqual({ reapplied: 0, unchanged: 1 });
  });
});

describe('the script', () => {
  const script = fileURLToPath(new URL('../../../scripts/db-erasure-replay.ts', import.meta.url));

  function run(database: TestDatabase, ...args: string[]): string {
    return execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        UJIRA_DB_OPS_URL: roleUrl(roleUrls, 'ujira_ops', database.name),
      },
    });
  }

  it('exports to a file and replays from it, and will not overwrite an export', async () => {
    await erase();
    const directory = mkdtempSync(join(tmpdir(), 'erasure-'));
    const file = join(directory, 'erased.jsonl');
    try {
      expect(run(source, 'export', file)).toMatch(/exported \d+ erasure\(s\)/);
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      const subjects = lines.map((line) => parseExportLine(line).subjectId);
      expect(subjects).toContain(fixture.recipientId);
      expect(run(source, 'replay', file)).toBe(
        `db-erasure-replay: 0 reapplied, ${String(lines.length)} unchanged\n`,
      );
      expect(() => run(source, 'export', file)).toThrow();
      expect(readFileSync(file, 'utf8').trim().split('\n')).toEqual(lines);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('the export', () => {
  it('holds ids and a time, and reads back through its own check', async () => {
    await erase();
    const list = await exported(source);
    const mine = list.find((subject) => subject.subjectId === fixture.recipientId);
    expect(mine).toBeDefined();
    expect(Object.keys(mine ?? {}).sort()).toEqual([
      'erasedAt',
      'principalId',
      'projectId',
      'subjectId',
    ]);
    expect(parseExportLine(JSON.stringify(mine))).toEqual(mine);
  });

  it('refuses a line with anything else on it', () => {
    const line = {
      principalId: randomUUID(),
      projectId: randomUUID(),
      subjectId: randomUUID(),
      erasedAt: new Date().toISOString(),
    };
    expect(() => parseExportLine(JSON.stringify({ ...line, email: 'a@example.com' }))).toThrow();
    expect(() => parseExportLine(JSON.stringify({ ...line, subjectId: 'nope' }))).toThrow();
  });
});

describe('who may run it', () => {
  it('only the ops login can call these functions', async () => {
    const stranger = randomUUID();
    const others = [
      'ujira_app',
      'ujira_reader',
      'ujira_retention',
      'ujira_auth',
      'ujira_indexer',
    ] as const;
    for (const role of others) {
      const client = new pg.Client({ connectionString: roleUrl(roleUrls, role, source.name) });
      await client.connect();
      try {
        for (const statement of [
          `select * from ujira.erased_subjects(null, 10)`,
          `select ujira.replay_erasure('${stranger}', '${stranger}', '${stranger}')`,
        ]) {
          await expect(client.query(statement), `${role}: ${statement}`).rejects.toMatchObject({
            code: '42501',
          });
        }
      } finally {
        await client.end();
      }
    }
  });

  it('the ops login can do nothing else with these tables', async () => {
    await asOps(source, async (client) => {
      for (const statement of [
        'select * from ujira.data_keys',
        'select * from ujira.recipient_pii',
        'select * from ujira.erasure_log',
        'delete from ujira.recipient_pii',
      ]) {
        await expect(client.query(statement), statement).rejects.toMatchObject({ code: '42501' });
      }
    });
  });
});
