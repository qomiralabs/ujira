// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The deploy step that installs the queue's schema, before any service rolls. Pools
// would otherwise migrate it themselves on start, on whichever version happened to
// start first.
//
// It refuses to touch a schema that is behind while any pool holds a lock, because
// those pools are running against the schema it is about to change. It does not try
// to tell a breaking migration from a safe one: the version is pinned exactly, so an
// upgrade is rare and deliberate, and draining the old pools first is always safe.

import {
  createDatabase,
  loadDatabaseConfig,
  withWorkerInstallGrant,
  workerPools,
  type Database,
  type DatabaseConfig,
} from '@ujira/db';
import { runMigrations, type Logger } from 'graphile-worker';

import { WorkerConfigError } from './errors.js';
import type { WorkerEnvironment } from './process.js';
import { WORKER_SCHEMA_REVISION } from './settings.js';

export interface WorkerInstallEnvironment extends WorkerEnvironment {
  // The platform admin, who alone can grant CREATE on the database. Used for that
  // grant and nothing else. Set in the deploy step, never on a running service.
  readonly UJIRA_DB_ADMIN_URL?: string | undefined;
}

// Pools hold locks on a schema this install would change. Their ids are all it names.
export class WorkerPoolsActiveError extends Error {
  override readonly name = 'WorkerPoolsActiveError';
  readonly pools: readonly string[];

  constructor(pools: readonly string[]) {
    super(
      `${String(pools.length)} worker pool(s) hold locks and a queue migration is pending: drain them first (${pools.join(', ')})`,
    );
    this.pools = pools;
  }
}

export type WorkerInstallOutcome = 'installed' | 'already_current';

export interface WorkerInstallOptions {
  readonly logger?: Logger;
}

async function install(
  db: Database,
  config: DatabaseConfig,
  adminUrl: string,
  options: WorkerInstallOptions,
): Promise<WorkerInstallOutcome> {
  const login = await db.unscoped(async (tx) => workerPools.login(tx), 'worker');
  if (login !== 'ujira_worker') {
    throw new WorkerConfigError('UJIRA_DB_WORKER_URL must log in as ujira_worker');
  }
  const before = await db.unscoped(async (tx) => workerPools.queueState(tx), 'worker');
  if (before.schemaRevision === WORKER_SCHEMA_REVISION) return 'already_current';
  if (before.schemaRevision !== null && before.schemaRevision > WORKER_SCHEMA_REVISION) {
    throw new WorkerConfigError(
      `the queue schema is at revision ${String(before.schemaRevision)}, newer than the ${String(WORKER_SCHEMA_REVISION)} this version installs`,
    );
  }
  if (before.schemaRevision !== null) {
    const pools = await db.unscoped(async (tx) => workerPools.lockHolders(tx), 'worker');
    if (pools.length > 0) throw new WorkerPoolsActiveError(pools);
  }
  await withWorkerInstallGrant(adminUrl, config, async () => {
    await runMigrations({
      pgPool: db.workerPool(),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  });
  const after = await db.unscoped(async (tx) => workerPools.queueState(tx), 'worker');
  if (after.schemaRevision !== WORKER_SCHEMA_REVISION) {
    throw new WorkerConfigError(
      `the install left the queue schema at revision ${String(after.schemaRevision ?? 'none')}, not ${String(WORKER_SCHEMA_REVISION)}`,
    );
  }
  return 'installed';
}

export async function installWorkerSchema(
  env: WorkerInstallEnvironment,
  options: WorkerInstallOptions = {},
): Promise<WorkerInstallOutcome> {
  const adminUrl = env.UJIRA_DB_ADMIN_URL;
  if (adminUrl === undefined || adminUrl.trim() === '') {
    throw new WorkerConfigError('UJIRA_DB_ADMIN_URL is required');
  }
  const config = loadDatabaseConfig(env);
  const db = createDatabase(config);
  try {
    return await install(db, config, adminUrl, options);
  } finally {
    await db.close();
  }
}
