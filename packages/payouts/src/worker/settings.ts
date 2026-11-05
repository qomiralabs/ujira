// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The worker's settings. The two batch delays are correctness, not tuning: with
// the defaults, Graphile Worker 0.18.0 sends a job's completion without waiting
// for it, so a job that finishes during a graceful shutdown stays locked once the
// process exits. worker-config.test.ts fails if either changes.
export const WORKER_SETTINGS = Object.freeze({
  completeJobBatchDelay: 0,
  failJobBatchDelay: 0,
  // How long a running job gets to finish after a shutdown starts, before its
  // abort signal fires. The platform's kill grace must exceed this.
  gracefulShutdownAbortTimeout: 5_000,
  // Off while mandates use named queues. It made a mixed run on four of them about
  // six times slower when measured.
  localQueue: Object.freeze({ size: -1 }),
});

// The preset the pool runs with. A fresh copy, since the library's types take
// mutable objects and the settings above stay frozen.
export function workerPreset(concurrentJobs: number) {
  return {
    worker: {
      ...WORKER_SETTINGS,
      localQueue: { ...WORKER_SETTINGS.localQueue },
      concurrentJobs,
    },
  };
}

// Handlers hold connections on the app pool, not this one, so a pool of 4 serves
// these and the library's own listener.
export const DEFAULT_CONCURRENCY = 3;

export const HEARTBEAT_EVERY_MS = 15_000;

// The queue schema Graphile Worker 0.18.0 installs. A pool on an older schema would
// upgrade it, which is the deploy step's job, so a worker refuses to start on any
// other revision. A test holds this equal to what the pinned library installs.
export const WORKER_SCHEMA_REVISION = 20;

// A pool silent this long is taken for dead, and its locks are freed.
export const STALE_AFTER_SECONDS = 120;

// The sweep over chain submissions still open. A funding account's submission stays
// broadcast until this runs, so this is what closes it, and what raises the stuck
// alert when it cannot be closed.
export const SUBMISSION_SWEEP = Object.freeze({
  olderThanSeconds: 60,
  limit: 100,
  stuckAfterSeconds: 900,
});

// The most the reconcile function returns at once.
export const SWEEP_PAGE_SIZE = 500;
