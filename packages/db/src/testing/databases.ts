// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A Database for one test database that connects as the real service roles,
// so row level security applies exactly as in production.
//
// The indexer pool logs in as ujira_indexer, as it does in production. The
// worker login has no rights on tenant tables, and its role does not exist in
// these databases until the worker roles land, so for now the worker pool logs in
// as ujira_ops, which holds none either. Nothing here writes tenant rows through
// it.

import { loadDatabaseConfig } from '../config.js';
import { createDatabase, type Database } from '../database.js';
import { roleUrl, type TestDatabase } from './harness.js';

export function databaseAsServiceRoles(
  roleUrls: Readonly<Record<string, string>>,
  database: TestDatabase,
  appPoolSize = 2,
): Database {
  return createDatabase(
    loadDatabaseConfig({
      UJIRA_DB_APP_URL: roleUrl(roleUrls, 'ujira_app', database.name),
      UJIRA_DB_READER_URL: roleUrl(roleUrls, 'ujira_reader', database.name),
      UJIRA_DB_WORKER_URL: roleUrl(roleUrls, 'ujira_ops', database.name),
      UJIRA_DB_INDEXER_URL: roleUrl(roleUrls, 'ujira_indexer', database.name),
      UJIRA_DB_MIGRATION_URL: database.url,
      UJIRA_DB_TLS: 'off',
      UJIRA_DB_APP_POOL_SIZE: String(appPoolSize),
    }),
  );
}
