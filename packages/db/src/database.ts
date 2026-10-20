// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The query layer. Nothing outside this package imports pg or kysely, so
// every query runs through here, under a tenant context, inside one
// transaction.
//
// The transaction is opened by this package rather than by kysely, because
// `begin` and the tenant context travel in one statement, which is one
// round trip. The spike measured the context statement on its own costing a
// whole round trip from outside the region. Kysely is then handed that one
// client with a driver whose transaction methods are never used.

import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  type CompiledQuery,
} from 'kysely';
import pg from 'pg';

import type { DatabaseConfig, RoleConnection } from './config.js';
import { assertNoSessionState } from './session-state.js';
import { beginWithTenant, type TenantContext } from './tenant.js';
import type { Schema } from './schema.generated.js';

export type DatabaseRole = 'app' | 'worker' | 'reader' | 'migration';

// One pg connection, wrapped for kysely. Exported for its own tests only. Every statement passes the session
// state guard first: a leaked `SET` would outlive the transaction on a
// pooled backend, which the spike measured reaching another client.
export class ClientConnection implements DatabaseConnection {
  constructor(private readonly client: pg.PoolClient) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    assertNoSessionState(compiledQuery.sql);
    const result = await this.client.query<never>({
      text: compiledQuery.sql,
      values: [...compiledQuery.parameters],
    });
    return {
      rows: result.rows,
      numAffectedRows: BigInt(result.rowCount ?? 0),
    };
  }

  // Streaming would hold a cursor open across statements, which a
  // transaction pooler does not promise. Nothing needs it yet.
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streaming is not supported on a pooled connection');
  }
}

// Hands kysely the one client this transaction already owns. Exported for
// its own tests, not from the package entry: index.ts exports no driver.
// The transaction methods throw: this package sends `begin` with the context itself, and a
// second `begin` from kysely would be a silently nested transaction.
export class OwnedClientDriver implements Driver {
  constructor(private readonly connection: DatabaseConnection) {}

  // The driver interface is async; this one owns a connection that is
  // already open, so these resolve or throw without awaiting anything.
  init(): Promise<void> {
    return Promise.resolve();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(this.connection);
  }

  beginTransaction(): Promise<void> {
    return Promise.reject(
      new Error('the transaction is opened with the tenant context; use withTenant'),
    );
  }

  commitTransaction(): Promise<void> {
    return Promise.reject(new Error('the transaction is committed by withTenant'));
  }

  rollbackTransaction(): Promise<void> {
    return Promise.reject(new Error('the transaction is rolled back by withTenant'));
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

function dialectFor(connection: DatabaseConnection): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new OwnedClientDriver(connection),
    createIntrospector: (db: Kysely<Schema>) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

export interface Database {
  // Runs the work in one transaction, under the tenant context.
  readonly withTenant: <T>(
    role: DatabaseRole,
    context: TenantContext,
    work: (db: Kysely<Schema>) => Promise<T>,
  ) => Promise<T>;
  readonly close: () => Promise<void>;
}

function poolFor(role: RoleConnection, config: DatabaseConfig): pg.Pool {
  return new pg.Pool({
    connectionString: role.url,
    max: role.poolSize,
    connectionTimeoutMillis: config.acquireTimeoutMs,
    // Type parsers are left exactly as pg ships them. Changing one would
    // change every value of that type everywhere, so the lint rules ban
    // setTypeParser across the repository.
  });
}

// Timeouts are sent as transaction local settings in the same statement as
// the context, not as session settings: a session setting on a pooled
// backend reaches the next client, which the spike measured.
function timeoutSettings(config: DatabaseConfig): string {
  return [
    `set_config('statement_timeout', '${String(config.statementTimeoutMs)}', true)`,
    `set_config('lock_timeout', '${String(config.lockTimeoutMs)}', true)`,
  ].join(', ');
}

export function createDatabase(config: DatabaseConfig): Database {
  const pools: Record<DatabaseRole, pg.Pool> = {
    app: poolFor(config.app, config),
    worker: poolFor(config.worker, config),
    reader: poolFor(config.reader, config),
    migration: poolFor(config.migration, config),
  };

  let closed = false;

  return {
    withTenant: async (role, context, work) => {
      // The context is checked before a connection is taken, so a malformed
      // tenant fails with what was wrong rather than with whatever the
      // connection attempt happened to say, and never costs a connection.
      const begin = `${beginWithTenant(context)}, ${timeoutSettings(config)}`;
      const client = await pools[role].connect();
      let open = false;
      try {
        // One round trip: begin, the tenant context, and the timeouts.
        await client.query(begin);
        open = true;
        const db = new Kysely<Schema>({ dialect: dialectFor(new ClientConnection(client)) });
        const result = await work(db);
        await client.query('commit');
        open = false;
        return result;
      } catch (error) {
        if (open) {
          // A rollback that fails must not hide the error that caused it.
          await client.query('rollback').catch(() => undefined);
        }
        throw error;
      } finally {
        client.release();
      }
    },
    // Idempotent: a teardown path that closes twice, or a test that closes
    // after an error, must not fail on the second call. pg throws on a
    // second end of the same pool.
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all(Object.values(pools).map(async (pool) => pool.end()));
    },
  };
}
