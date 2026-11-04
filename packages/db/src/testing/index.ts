// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What another package's tests need to run against a real database: a fresh
// database per file and a Database logged in as the real service roles. The
// container itself starts in this package's global setup, which a test project
// names in the root vitest config.

export { createTestDatabase, type TestDatabase } from './harness.js';
export { databaseAsServiceRoles } from './databases.js';
