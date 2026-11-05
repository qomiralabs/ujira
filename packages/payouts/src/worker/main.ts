// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Runs the payouts worker: `pnpm --filter @ujira/payouts build`, then
// `pnpm --filter @ujira/payouts start`. Reads the UJIRA_DB_* variables and
// UJIRA_WORKER_CONCURRENCY, and exits non-zero if it refuses to start.
//
// A first signal lets running jobs finish within the grace. A second gives up.

import { describeRefusal, startWorkerProcess } from './process.js';

function refuse(error: unknown): never {
  process.stderr.write(`worker: ${describeRefusal(error)}\n`);
  process.exit(1);
}

try {
  const worker = await startWorkerProcess(process.env);
  let stopping = false;
  const stop = (): void => {
    if (stopping) process.exit(1);
    stopping = true;
    worker.stop().catch(refuse);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await worker.done;
  process.exit(0);
} catch (error) {
  refuse(error);
}
