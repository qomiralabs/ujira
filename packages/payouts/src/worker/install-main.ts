// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The deploy step: `pnpm --filter @ujira/payouts worker:install`, after the app
// migrations and before any service rolls. Reads the UJIRA_DB_* variables and
// UJIRA_DB_ADMIN_URL, and exits non-zero if it refuses or fails.

import { installWorkerSchema } from './install.js';
import { describeRefusal, processLogger } from './process.js';

try {
  const outcome = await installWorkerSchema(process.env, { logger: processLogger() });
  process.stdout.write(`worker install: ${outcome}\n`);
  process.exit(0);
} catch (error) {
  process.stderr.write(`worker install: ${describeRefusal(error)}\n`);
  process.exit(1);
}
