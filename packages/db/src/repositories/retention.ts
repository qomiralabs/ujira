// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Removes short-lived records past their window. Run with the worker pool pointed
// at the ujira_retention login, the same way the fee estimates refresh runs as
// ujira_ops. There is no date in these statements on purpose: the role's policies
// are what say a row has expired, so no change here can widen what it removes.
//
// Not in the cross-tenant matrix, because it has no tenant. Its bound is the role,
// which retention.test.ts proves.

import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';
import type { Schema } from '../schema.generated.js';

export const RETENTION_BATCH_SIZE = 1000;

// Enough for a backlog of a million rows per table in one run, while keeping a run
// from going on forever if rows expire as fast as it removes them.
const MAX_BATCHES_PER_TABLE = 1000;

// Deliveries before events, because a delivery holds a foreign key to its event.
const TABLES = ['webhook_deliveries', 'outbox_events', 'idempotency_keys'] as const;

export type RetentionTable = (typeof TABLES)[number];

export type RetentionCounts = Readonly<Record<RetentionTable, number>>;

export const retention = {
  // One batch in the transaction it is given. The count is how many went.
  deleteBatch: async (
    db: Kysely<Schema>,
    table: RetentionTable,
    limit: number,
  ): Promise<number> => {
    const target = sql.table(`ujira.${table}`);
    const result = await sql`
      delete from ${target} where id in (select id from ${target} limit ${limit})
    `.execute(db);
    return Number(result.numAffectedRows ?? 0n);
  },
};

// Each batch is its own transaction, so a large backlog never holds one long lock,
// and an error stops the run and reaches the caller. A rerun picks up where it
// stopped.
export async function runRetention(
  db: Database,
  batchSize: number = RETENTION_BATCH_SIZE,
): Promise<RetentionCounts> {
  const counts: Record<RetentionTable, number> = {
    webhook_deliveries: 0,
    outbox_events: 0,
    idempotency_keys: 0,
  };
  for (const table of TABLES) {
    for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
      const deleted = await db.unscoped(
        async (tx) => retention.deleteBatch(tx, table, batchSize),
        'worker',
      );
      counts[table] += deleted;
      if (deleted < batchSize) break;
    }
  }
  return counts;
}
