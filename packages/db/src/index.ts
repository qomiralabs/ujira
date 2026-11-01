// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The public entry of the database package. Everything that reaches a
// database goes through here: the driver and the query builder are imports
// of this package alone, enforced by a lint fence, so no caller can open a
// connection without a tenant context.
//
// What is deliberately not exported: the pg pool, the kysely instance and
// the generated schema types. A caller that needs a query needs a
// repository method, which arrives with the tables.

export { createDatabase, type Database, type DatabaseRole } from './database.js';
export {
  CONNECTION_BUDGET,
  loadDatabaseConfig,
  POOL_DEFAULTS,
  type DatabaseConfig,
  type DatabaseEnvironment,
  type RoleConnection,
  type TlsMode,
} from './config.js';
// Exported so a deployment can check which certificate it is pinning
// without importing the driver.
export { PINNED_TLS, SUPABASE_ROOT_2021_CA_FINGERPRINT } from './tls.js';
export {
  runMigrations,
  type LockMode,
  type MigrationDirection,
  type MigrationRun,
} from './migrate.js';
export { TENANT_SETTINGS, type TenantContext, type TenantScope } from './tenant.js';
export { DatabaseConfigError, SessionStateError, TenantContextError } from './errors.js';
export { DatabaseUnavailableError } from './unavailable.js';
