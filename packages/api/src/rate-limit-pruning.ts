// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Keeps the rate limit table from growing without bound. Every distinct client address
// that is ever limited leaves a bucket, and one that has refilled completely can go,
// because a missing bucket starts full. The API writes the buckets and is always
// running, so it clears them too, a bounded pass at a time, until the job queue can.

import { errorNameOf } from './log.js';
import type { Logger } from './log.js';

export interface RateLimitPruningOptions {
  /** Deletes up to `maxRows` full buckets in one transaction and says how many. */
  readonly prune: (maxRows: number) => Promise<number>;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  /** Batches in one pass, so a pass is bounded however much is full. */
  readonly maxBatches?: number;
}

export interface RateLimitPruning {
  /** One pass now, returning how many buckets it removed. Throws what a batch threw. */
  runOnce(): Promise<number>;
  /** Stops the interval and waits for a pass already running. */
  stop(): Promise<void>;
}

const DEFAULTS = { intervalMs: 60_000, batchSize: 1000, maxBatches: 10 };

export function startRateLimitPruning(options: RateLimitPruningOptions): RateLimitPruning {
  const intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
  const batchSize = options.batchSize ?? DEFAULTS.batchSize;
  const maxBatches = options.maxBatches ?? DEFAULTS.maxBatches;
  let running: Promise<number> | null = null;

  async function pass(): Promise<number> {
    let removed = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const count = await options.prune(batchSize);
      removed += count;
      if (count < batchSize) break;
    }
    return removed;
  }

  function runOnce(): Promise<number> {
    // A pass still running is the one this caller gets, so two never overlap.
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  }

  const timer = setInterval(() => {
    if (running !== null) return;
    runOnce().catch((error: unknown) => {
      // The next pass tries again, so this only has to be seen, not handled.
      options.logger.write({
        time: new Date().toISOString(),
        level: 'warn',
        event: 'rate_limit_prune_failed',
        errorName: errorNameOf(error),
      });
    });
  }, intervalMs);
  // Pruning alone never keeps a process alive.
  timer.unref();

  return {
    runOnce,
    async stop() {
      clearInterval(timer);
      await running?.catch(() => undefined);
    },
  };
}
