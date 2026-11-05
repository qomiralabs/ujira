// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One network's scan, put together against the database. Which chain it is stays
// with the caller, which hands in where events come from and the intake that
// recomputes that chain's tenant tags, so nothing here can branch on a chain.

import {
  createEventScan,
  type EventIntake,
  type EventIntakeStore,
  type EventSource,
  type NetworkId,
} from '@ujira/chain-adapter';
import type { Database } from '@ujira/db';

import { dbCursorStore, dbIntakeStore } from './stores.js';

export interface IndexerScanOptions {
  readonly db: Database;
  readonly network: NetworkId;
  readonly source: EventSource;
  readonly intakeFor: (store: EventIntakeStore) => EventIntake;
  /** Events a page reads. At most what the node allows. */
  readonly pageSize: number;
}

export function createIndexerScan(options: IndexerScanOptions) {
  const { db, network, source, intakeFor, pageSize } = options;
  return createEventScan({
    network,
    source,
    intake: intakeFor(dbIntakeStore(db)),
    cursors: dbCursorStore(db),
    pageSize,
  });
}
