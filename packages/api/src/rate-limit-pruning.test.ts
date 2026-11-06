// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { memoryLogger } from './log.js';
import { startRateLimitPruning } from './rate-limit-pruning.js';

// Each batch answers with the next count from the list, and records the size it was given.
function batches(counts: readonly (number | Error)[]) {
  const asked: number[] = [];
  let next = 0;
  const prune = (maxRows: number): Promise<number> => {
    asked.push(maxRows);
    const answer = counts[next] ?? 0;
    next += 1;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { prune, asked };
}

describe('rate limit pruning', () => {
  it('prunes batch after batch until one comes back short', async () => {
    const { prune, asked } = batches([3, 3, 1]);
    const pruning = startRateLimitPruning({ prune, logger: memoryLogger(), batchSize: 3 });
    expect(await pruning.runOnce()).toBe(7);
    expect(asked).toEqual([3, 3, 3]);
    await pruning.stop();
  });

  it('stops after its last batch in one pass, so a pass is bounded however much is full', async () => {
    const { prune, asked } = batches([2, 2, 2, 2, 2]);
    const pruning = startRateLimitPruning({
      prune,
      logger: memoryLogger(),
      batchSize: 2,
      maxBatches: 3,
    });
    expect(await pruning.runOnce()).toBe(6);
    expect(asked).toHaveLength(3);
    await pruning.stop();
  });

  it('logs a failed pass by class name and keeps running on the next one', async () => {
    const logger = memoryLogger();
    const { prune } = batches([new TypeError('connection reset'), 1]);
    const pruning = startRateLimitPruning({ prune, logger, batchSize: 5, intervalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await pruning.stop();
    const failed = logger.records.filter((record) => record.event === 'rate_limit_prune_failed');
    expect(failed[0]).toMatchObject({ level: 'warn', errorName: 'TypeError' });
    expect(JSON.stringify(logger.records)).not.toContain('connection reset');
  });

  it('never runs two passes at once, and stops cleanly', async () => {
    let running = 0;
    let most = 0;
    const prune = async (): Promise<number> => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 30));
      running -= 1;
      return 0;
    };
    const pruning = startRateLimitPruning({ prune, logger: memoryLogger(), intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await pruning.stop();
    expect(most).toBe(1);
    expect(running).toBe(0);
  });
});
