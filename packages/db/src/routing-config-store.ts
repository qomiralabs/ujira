// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The routing configuration in Postgres, in the shape the router's store port
// asks for. Services read through the app role and the narrow functions, and
// hold no way to write. Only an operations tool, logged in as ujira_ops, gets a
// store that can. The store does not validate a document: the router does, on
// the way in and again on the way out, so a bad row is its problem to refuse.

import type { Database } from './database.js';
import { routingConfig } from './repositories/ops.js';

interface StoreCall {
  readonly signal: AbortSignal;
}

export interface RoutingConfigRow {
  readonly version: number;
  readonly document: unknown;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface PostgresRoutingConfigStore {
  insertVersion(
    input: { readonly document: unknown; readonly createdBy: string },
    opts: StoreCall,
  ): Promise<{ readonly version: number }>;
  getVersion(version: number, opts: StoreCall): Promise<RoutingConfigRow | null>;
  activate(version: number, opts: StoreCall): Promise<void>;
  readActivePointer(opts: StoreCall): Promise<number | null>;
}

/** A write through a store built for reading, which a service never needs. */
export class RoutingConfigReadOnlyError extends Error {
  override readonly name = 'RoutingConfigReadOnlyError';

  constructor() {
    super('This routing configuration store has no write connection');
  }
}

type Connection = Pick<Database, 'unscoped'>;

// Version numbers are an identity column that grows by one per document, so a
// number is safe for as long as anyone could write them. A value past that is
// a broken row, and should not be rounded into some other version.
function toVersion(value: bigint): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version)) {
    throw new RangeError('routing configuration version out of range');
  }
  return version;
}

/**
 * `reads` is the service's own database, whose app role reaches the narrow
 * functions. `writes` is a database logged in as ujira_ops, from
 * opsConnectionConfig; left out, writing throws RoutingConfigReadOnlyError.
 *
 * The signal is honoured before a statement starts. Once one is running, the
 * transaction's statement timeout bounds it and the caller's deadline has
 * already moved on.
 */
export function createRoutingConfigStore(connections: {
  readonly reads: Connection;
  readonly writes?: Connection;
}): PostgresRoutingConfigStore {
  const { reads, writes } = connections;
  const writer = (): Connection => {
    if (writes === undefined) throw new RoutingConfigReadOnlyError();
    return writes;
  };
  return {
    async insertVersion(input, opts) {
      opts.signal.throwIfAborted();
      const version = await writer().unscoped((tx) => routingConfig.insertVersion(tx, input));
      return { version: toVersion(version) };
    },
    async getVersion(version, opts) {
      opts.signal.throwIfAborted();
      const row = await reads.unscoped((tx) => routingConfig.version(tx, BigInt(version)));
      if (row === undefined) return null;
      return {
        version: toVersion(row.version),
        document: row.document,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      };
    },
    async activate(version, opts) {
      opts.signal.throwIfAborted();
      await writer().unscoped((tx) => routingConfig.activate(tx, BigInt(version)));
    },
    async readActivePointer(opts) {
      opts.signal.throwIfAborted();
      const version = await reads.unscoped((tx) => routingConfig.activeVersion(tx));
      return version === undefined ? null : toVersion(version);
    },
  };
}
