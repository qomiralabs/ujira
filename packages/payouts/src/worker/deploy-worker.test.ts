// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The worker install, each case on a database of its own. The kill grace criterion of
// the deploy issue is held until a hosting account and its configuration exist.

import { withWorkerInstallGrant } from '@ujira/db';
import { adminQuery, harnessDatabase, type HarnessDatabase } from '@ujira/db/testing';
import { describe, expect, it } from 'vitest';

import { WorkerConfigError } from './errors.js';
import {
  WorkerPoolsActiveError,
  installWorkerSchema,
  type WorkerInstallEnvironment,
} from './install.js';
import { WORKER_SCHEMA_REVISION } from './settings.js';
import { quiet } from './testing/support.js';

function envFor(harness: HarnessDatabase): WorkerInstallEnvironment {
  return {
    UJIRA_DB_APP_URL: harness.loginUrl('ujira_app'),
    UJIRA_DB_READER_URL: harness.loginUrl('ujira_reader'),
    UJIRA_DB_WORKER_URL: harness.loginUrl('ujira_worker'),
    UJIRA_DB_MIGRATION_URL: harness.database.url,
    UJIRA_DB_ADMIN_URL: harness.database.url,
    UJIRA_DB_TLS: 'off',
  };
}

async function withClone(
  name: string,
  check: (clone: HarnessDatabase) => Promise<void>,
): Promise<void> {
  const clone = await harnessDatabase(`${import.meta.url}#${name}`);
  try {
    await check(clone);
  } finally {
    await clone.database.drop();
  }
}

async function revision(clone: HarnessDatabase): Promise<number | null> {
  const rows = await adminQuery<{ revision: number | null }>(
    clone.database.url,
    'select max(id)::int as revision from graphile_worker.migrations',
  );
  return rows[0]?.revision ?? null;
}

async function hasCreate(clone: HarnessDatabase): Promise<boolean | undefined> {
  const rows = await adminQuery<{ allowed: boolean }>(
    clone.database.url,
    `select has_database_privilege('ujira_worker', current_database(), 'CREATE') as allowed`,
  );
  return rows[0]?.allowed;
}

const UNINSTALL = `
  drop schema graphile_worker cascade;
  create schema graphile_worker authorization ujira_worker
`;
const STEP_BACK = `
  delete from graphile_worker.migrations
   where id = (select max(id) from graphile_worker.migrations)
`;

describe('the worker install', () => {
  it('installs as ujira_worker, and takes CREATE back afterwards', async () => {
    await withClone('fresh', async (clone) => {
      await adminQuery(clone.database.url, UNINSTALL);
      expect(await installWorkerSchema(envFor(clone), { logger: quiet })).toBe('installed');
      expect(await revision(clone)).toBe(WORKER_SCHEMA_REVISION);
      expect(await hasCreate(clone)).toBe(false);
      const owners = await adminQuery<{ owner: string }>(
        clone.database.url,
        `select distinct pg_get_userbyid(c.relowner) as owner
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'graphile_worker'`,
      );
      expect(owners).toEqual([{ owner: 'ujira_worker' }]);
    });
  });

  it('with nothing to do, it does nothing, and grants nothing', async () => {
    await withClone('current', async (clone) => {
      // The admin URL is unreachable, so reaching for it at all would fail this.
      const env = { ...envFor(clone), UJIRA_DB_ADMIN_URL: 'postgresql://nobody@127.0.0.1:9/none' };
      expect(await installWorkerSchema(env, { logger: quiet })).toBe('already_current');
      expect(await hasCreate(clone)).toBe(false);
    });
  });

  it('locks held by old-version pools stop the deploy', async () => {
    await withClone('active', async (clone) => {
      await adminQuery(clone.database.url, STEP_BACK);
      await adminQuery(
        clone.database.url,
        `select graphile_worker.add_job('test:held', '{}'::json)`,
      );
      await adminQuery(
        clone.database.url,
        `update graphile_worker._private_jobs set locked_by = 'pool-old', locked_at = now()`,
      );
      const refused = installWorkerSchema(envFor(clone), { logger: quiet });
      await expect(refused).rejects.toBeInstanceOf(WorkerPoolsActiveError);
      await expect(refused).rejects.toThrow('pool-old');
      // Nothing moved, and nothing was granted.
      expect(await revision(clone)).toBe(WORKER_SCHEMA_REVISION - 1);
      expect(await hasCreate(clone)).toBe(false);
    });
  });

  it('a queue lock counts as much as a job lock', async () => {
    await withClone('queue-lock', async (clone) => {
      await adminQuery(clone.database.url, STEP_BACK);
      await adminQuery(
        clone.database.url,
        `select graphile_worker.add_job('test:held', '{}'::json, queue_name => 'q')`,
      );
      await adminQuery(
        clone.database.url,
        `update graphile_worker._private_job_queues set locked_by = 'pool-q', locked_at = now()`,
      );
      await expect(installWorkerSchema(envFor(clone), { logger: quiet })).rejects.toThrow('pool-q');
    });
  });

  it('with no locks held, a schema behind the pin is brought up to it', async () => {
    await withClone('behind', async (clone) => {
      await adminQuery(clone.database.url, STEP_BACK);
      expect(await installWorkerSchema(envFor(clone), { logger: quiet })).toBe('installed');
      expect(await revision(clone)).toBe(WORKER_SCHEMA_REVISION);
      expect(await hasCreate(clone)).toBe(false);
    });
  });

  it('an install that fails part way takes CREATE back, and says so', async () => {
    await withClone('fails', async (clone) => {
      // Back to the start with every object still there, so the early migrations
      // cannot apply again.
      await adminQuery(clone.database.url, 'delete from graphile_worker.migrations where id > 1');
      await expect(installWorkerSchema(envFor(clone), { logger: quiet })).rejects.toThrow();
      expect(await hasCreate(clone)).toBe(false);
    });
  });

  it('refuses a schema newer than this version installs', async () => {
    await withClone('newer', async (clone) => {
      await adminQuery(
        clone.database.url,
        `insert into graphile_worker.migrations (id, breaking) values (${String(WORKER_SCHEMA_REVISION + 1)}, false)`,
      );
      await expect(installWorkerSchema(envFor(clone), { logger: quiet })).rejects.toBeInstanceOf(
        WorkerConfigError,
      );
    });
  });

  it('refuses another login, and a missing admin URL', async () => {
    await withClone('login', async (clone) => {
      await expect(
        installWorkerSchema(
          { ...envFor(clone), UJIRA_DB_WORKER_URL: clone.loginUrl('ujira_indexer') },
          { logger: quiet },
        ),
      ).rejects.toThrow('must log in as ujira_worker');
      await expect(
        installWorkerSchema({ ...envFor(clone), UJIRA_DB_ADMIN_URL: undefined }),
      ).rejects.toThrow('UJIRA_DB_ADMIN_URL is required');
    });
  });
});

describe('withWorkerInstallGrant', () => {
  it('holds the grant only while the work runs, and returns its result', async () => {
    await withClone('window', async (clone) => {
      const during = await withWorkerInstallGrant(
        clone.database.url,
        { tlsOptions: undefined },
        () => hasCreate(clone),
      );
      expect(during).toBe(true);
      expect(await hasCreate(clone)).toBe(false);
    });
  });

  it('takes it back when the work throws', async () => {
    await withClone('window-throws', async (clone) => {
      await expect(
        withWorkerInstallGrant(clone.database.url, { tlsOptions: undefined }, () =>
          Promise.reject(new Error('install failed')),
        ),
      ).rejects.toThrow('install failed');
      expect(await hasCreate(clone)).toBe(false);
    });
  });
});
