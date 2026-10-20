// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Where the database lives and how hard this process may lean on it. Four
// roles, each with its own login and its own pool: the app writes through
// the transaction pooler, the worker listens through the session pooler, the
// reader reads, and the migrator runs migrations.
//
// The numbers here come from the Supabase spike: max_connections is 60 on
// the project, the pooler's statement_timeout and lock_timeout are 8s, the
// transaction pooler delivers no LISTEN notification, and the migration
// tool's advisory lock is session scoped. The defaults are deliberately
// small; the deploy issue tunes them against real traffic.

import { DatabaseConfigError } from './errors.js';

export interface DatabaseEnvironment {
  UJIRA_DB_APP_URL?: string | undefined;
  UJIRA_DB_WORKER_URL?: string | undefined;
  UJIRA_DB_READER_URL?: string | undefined;
  UJIRA_DB_MIGRATION_URL?: string | undefined;
  UJIRA_DB_APP_POOL_SIZE?: string | undefined;
  UJIRA_DB_WORKER_POOL_SIZE?: string | undefined;
  UJIRA_DB_READER_POOL_SIZE?: string | undefined;
  UJIRA_DB_MIGRATION_POOL_SIZE?: string | undefined;
  UJIRA_DB_ACQUIRE_TIMEOUT_MS?: string | undefined;
  UJIRA_DB_STATEMENT_TIMEOUT_MS?: string | undefined;
  UJIRA_DB_LOCK_TIMEOUT_MS?: string | undefined;
}

export interface RoleConnection {
  readonly url: string;
  readonly poolSize: number;
}

export interface DatabaseConfig {
  readonly app: RoleConnection;
  readonly worker: RoleConnection;
  readonly reader: RoleConnection;
  readonly migration: RoleConnection;
  readonly acquireTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
}

// Measured on the project. `reservedForUs` leaves room for the dashboard,
// the Supabase API roles, a migration running beside the services and a
// person with psql.
export const CONNECTION_BUDGET = Object.freeze({
  maxConnections: 60,
  reservedForUs: 30,
});

// One instance of each service. Render runs several, so the deploy issue
// divides these by the instance count rather than raising them.
export const POOL_DEFAULTS = Object.freeze({
  app: 8,
  worker: 4,
  reader: 4,
  migration: 1,
});

// Under the pooler's 8s, so a statement here is cut by our limit and not by
// a limit we do not control.
const TIMEOUT_DEFAULTS = Object.freeze({
  acquireTimeoutMs: 5_000,
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 3_000,
});
const POOLER_TIMEOUT_MS = 8_000;

// Supavisor's transaction pooler. The worker cannot use it, because it
// delivers no LISTEN notification, and nor can the migrator, whose advisory
// lock is held in the session. Both are measured in the spike. The rule is
// written as a refusal of this port rather than a demand for 5432, so a
// local Postgres on any port still works.
const TRANSACTION_POOLER_PORT = '6543';

type Role = keyof typeof POOL_DEFAULTS;

const URL_KEYS: Readonly<Record<Role, keyof DatabaseEnvironment>> = {
  app: 'UJIRA_DB_APP_URL',
  worker: 'UJIRA_DB_WORKER_URL',
  reader: 'UJIRA_DB_READER_URL',
  migration: 'UJIRA_DB_MIGRATION_URL',
};

const POOL_KEYS: Readonly<Record<Role, keyof DatabaseEnvironment>> = {
  app: 'UJIRA_DB_APP_POOL_SIZE',
  worker: 'UJIRA_DB_WORKER_POOL_SIZE',
  reader: 'UJIRA_DB_READER_POOL_SIZE',
  migration: 'UJIRA_DB_MIGRATION_POOL_SIZE',
};

// Roles that must reach the session pooler.
const SESSION_ONLY: readonly Role[] = ['worker', 'migration'];

function fail(message: string): never {
  throw new DatabaseConfigError(message);
}

// A URL is never quoted back, because it carries the password.
function readUrl(env: DatabaseEnvironment, role: Role): string {
  const key = URL_KEYS[role];
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') fail(`${key} is required`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${key} is not a URL`);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    fail(`${key} must start with postgresql://`);
  }
  if (parsed.hostname === '') fail(`${key} has no host`);
  if (parsed.pathname.replace(/^\//, '') === '') fail(`${key} has no database name`);
  for (const name of parsed.searchParams.keys()) {
    if (name.toLowerCase().startsWith('ssl')) {
      fail(`${key} must not set ${name}; TLS trust is pinned in this package, not in the URL`);
    }
  }
  if (SESSION_ONLY.includes(role) && parsed.port === TRANSACTION_POOLER_PORT) {
    fail(
      `${key} must not use the transaction pooler port ${TRANSACTION_POOLER_PORT}: it delivers no LISTEN notification and breaks the migration lock, so this role needs a session connection`,
    );
  }
  return raw;
}

// Integers only, written plainly. A value with spaces or a decimal point is
// a typo worth stopping on rather than rounding.
function readInt(
  env: DatabaseEnvironment,
  key: keyof DatabaseEnvironment,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    fail(`${key} must be a whole number of at least 1`);
  }
  return Number(raw);
}

export function loadDatabaseConfig(env: DatabaseEnvironment): DatabaseConfig {
  const roles = {} as Record<Role, RoleConnection>;
  let total = 0;
  for (const role of Object.keys(POOL_DEFAULTS) as Role[]) {
    const poolSize = readInt(env, POOL_KEYS[role], POOL_DEFAULTS[role]);
    total += poolSize;
    roles[role] = Object.freeze({ url: readUrl(env, role), poolSize });
  }
  if (total > CONNECTION_BUDGET.reservedForUs) {
    fail(
      `the pool sizes add up to ${String(total)} connections, over the ${String(CONNECTION_BUDGET.reservedForUs)} this deployment may use of the database's ${String(CONNECTION_BUDGET.maxConnections)}`,
    );
  }

  const acquireTimeoutMs = readInt(
    env,
    'UJIRA_DB_ACQUIRE_TIMEOUT_MS',
    TIMEOUT_DEFAULTS.acquireTimeoutMs,
  );
  const statementTimeoutMs = readInt(
    env,
    'UJIRA_DB_STATEMENT_TIMEOUT_MS',
    TIMEOUT_DEFAULTS.statementTimeoutMs,
  );
  const lockTimeoutMs = readInt(env, 'UJIRA_DB_LOCK_TIMEOUT_MS', TIMEOUT_DEFAULTS.lockTimeoutMs);
  for (const [key, value] of [
    ['UJIRA_DB_STATEMENT_TIMEOUT_MS', statementTimeoutMs],
    ['UJIRA_DB_LOCK_TIMEOUT_MS', lockTimeoutMs],
  ] as const) {
    if (value >= POOLER_TIMEOUT_MS) {
      fail(
        `${key} must stay under the pooler's ${String(POOLER_TIMEOUT_MS)} ms limit, or it would never be reached`,
      );
    }
  }

  return Object.freeze({
    app: roles.app,
    worker: roles.worker,
    reader: roles.reader,
    migration: roles.migration,
    acquireTimeoutMs,
    statementTimeoutMs,
    lockTimeoutMs,
  });
}
