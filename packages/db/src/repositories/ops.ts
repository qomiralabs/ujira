// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The app's only way into schema ops: narrow functions that run as ujira_ops,
// called inside db.unscoped(), since these rows belong to no tenant. They hold no tenant data, so they sit outside the cross-tenant
// matrix; the no-customer-data tests are what keep that true.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';

type Tx = Kysely<Schema>;

export interface ExecutorLease {
  readonly accountRef: string;
  // int8 comes back from pg as text, and stays a bigint from here on.
  readonly nextSequence: bigint;
  readonly leaseExpiresAt: Date;
}

export interface RoutingConfig {
  readonly version: bigint;
  readonly document: unknown;
}

export interface RoutingConfigVersion extends RoutingConfig {
  readonly createdBy: string;
  readonly createdAt: Date;
}

export const executors = {
  // A free account on the network for this holder, or undefined when every
  // account is held. Concurrent callers never get the same one.
  lease: async (
    db: Tx,
    input: { readonly network: string; readonly holder: string; readonly leaseSeconds: number },
  ): Promise<ExecutorLease | undefined> => {
    const result = await sql<{
      account_ref: string;
      next_sequence: string;
      lease_expires_at: Date;
    }>`
      select account_ref, next_sequence, lease_expires_at
        from ops.lease_executor(${input.network}, ${input.holder}, ${input.leaseSeconds})
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      accountRef: row.account_ref,
      nextSequence: BigInt(row.next_sequence),
      leaseExpiresAt: row.lease_expires_at,
    };
  },

  // True when this holder still held the account. The sequence never moves
  // backwards, whatever is passed.
  release: async (
    db: Tx,
    input: {
      readonly network: string;
      readonly accountRef: string;
      readonly holder: string;
      readonly sequenceReached: bigint;
    },
  ): Promise<boolean> => {
    const result = await sql<{ released: boolean }>`
      select ops.release_executor(
        ${input.network}, ${input.accountRef}, ${input.holder}, ${input.sequenceReached.toString()}::bigint
      ) as released
    `.execute(db);
    return result.rows[0]?.released === true;
  },
};

export const routingConfig = {
  // The live configuration, or undefined before one is activated.
  active: async (db: Tx): Promise<RoutingConfig | undefined> => {
    const result = await sql<{ version: string; document: unknown }>`
      select version, document from ops.active_routing_config()
    `.execute(db);
    const row = result.rows[0];
    return row === undefined ? undefined : { version: BigInt(row.version), document: row.document };
  },

  // The number alone, because every service asks this every 30 seconds.
  activeVersion: async (db: Tx): Promise<bigint | undefined> => {
    const result = await sql<{ version: string | null }>`
      select ops.active_routing_config_version() as version
    `.execute(db);
    const version = result.rows[0]?.version;
    return version === undefined || version === null ? undefined : BigInt(version);
  },

  // One stored version, read through the same narrow door.
  version: async (db: Tx, version: bigint): Promise<RoutingConfigVersion | undefined> => {
    const result = await sql<{
      version: string;
      document: unknown;
      created_by: string;
      created_at: Date;
    }>`
      select version, document, created_by, created_at
        from ops.routing_config_version(${version.toString()}::bigint)
    `.execute(db);
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          version: BigInt(row.version),
          document: row.document,
          createdBy: row.created_by,
          createdAt: row.created_at,
        };
  },

  // The two writes run only as ujira_ops. The app role holds no grant on these
  // tables, so the database refuses them there.
  insertVersion: async (
    db: Tx,
    input: { readonly document: unknown; readonly createdBy: string },
  ): Promise<bigint> => {
    const result = await sql<{ version: string }>`
      insert into ops.routing_config_versions (document, created_by)
      values (${JSON.stringify(input.document)}::jsonb, ${input.createdBy})
      returning version
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) throw new RangeError('the insert returned no version');
    return BigInt(row.version);
  },

  // One statement, so readers see the old version or the new one and nothing
  // in between. The foreign key refuses a version that does not exist.
  activate: async (db: Tx, version: bigint): Promise<void> => {
    await sql`
      insert into ops.routing_config_active (version)
      values (${version.toString()}::bigint)
      on conflict (only_row) do update set version = excluded.version
    `.execute(db);
  },
};
