// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A real worker pool in a process of its own, so a test can send it a signal or
// kill it outright. Node runs this file directly, so it imports only packages, and
// the settings under test come in as an argument.
//
// Usage: pool-process.ts <connection string> <settings as JSON> <finish | hang>

import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger, run, type WorkerEvents } from 'graphile-worker';

const [connectionString, settings, mode] = process.argv.slice(2);
if (connectionString === undefined || settings === undefined || mode === undefined) {
  throw new Error('usage: pool-process.ts <connection string> <settings as JSON> <finish | hang>');
}

const events: WorkerEvents = new EventEmitter();
events.on('pool:create', ({ workerPool }) => {
  process.stdout.write(`pool ${workerPool.id}\n`);
});

await run({
  connectionString,
  events,
  logger: new Logger(() => () => undefined),
  preset: { worker: { ...(JSON.parse(settings) as Record<string, unknown>), concurrentJobs: 1 } },
  taskList: {
    'test:slow': async () => {
      process.stdout.write('started\n');
      // Long enough for the test to act while the job is running. A job that hangs
      // ignores its abort signal, as a stuck handler would.
      await sleep(mode === 'hang' ? 600_000 : 1_500);
      process.stdout.write('finished\n');
    },
  },
});
