// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Batch planning against a model of the mandate's execute batch: items run
// in order against one balance, each item's transfers land before the next
// item's checks, and the first failing item fails the whole batch.

import { describe, expect, it } from 'vitest';

import { bisectRounds, planBatch } from './bisect.js';
import type { BatchSimulation, BatchSimulationPort } from './bisect.js';
import { MandateRuleError, RpcTimeoutError } from './errors.js';
import type { MandateErrorName } from './mandate-errors.js';
import { isEventsLimitFailure } from './stellar/events-limit.js';

interface Item {
  readonly id: number;
  readonly amount: bigint;
  /** A spec error name this item always fails with, such as AGENT_REMOVED. */
  readonly fails?: { readonly code: number; readonly name: MandateErrorName };
}

interface Model extends BatchSimulationPort<Item> {
  readonly calls: number[][];
}

function model(options: { balance?: bigint; maxItems?: number } = {}): Model {
  const calls: number[][] = [];
  return {
    calls,
    simulate(items): Promise<BatchSimulation> {
      calls.push(items.map((i) => i.id));
      if (options.maxItems !== undefined && items.length > options.maxItems) {
        return Promise.resolve({ ok: false, kind: 'events_limit' });
      }
      let left = options.balance ?? 1_000_000n;
      for (const item of items) {
        if (item.fails !== undefined) {
          const error = new MandateRuleError(item.fails.code, item.fails.name);
          return Promise.resolve({ ok: false, kind: 'refused', error });
        }
        if (item.amount > left) {
          const error = new MandateRuleError(43, 'INSUFFICIENT_FUNDS');
          return Promise.resolve({ ok: false, kind: 'refused', error });
        }
        left -= item.amount;
      }
      return Promise.resolve({ ok: true });
    },
  };
}

const REFUSED = { code: 72, name: 'TRANSFER_FAILED' } as const;

function items(
  n: number,
  bad: readonly number[] = [],
  fails: { readonly code: number; readonly name: MandateErrorName } = REFUSED,
): Item[] {
  return Array.from({ length: n }, (_, id) => ({
    id,
    amount: 10n,
    ...(bad.includes(id) ? { fails } : {}),
  }));
}

describe('bisect', () => {
  it('one bad item in 20 is found in at most 5 rounds', async () => {
    for (let bad = 0; bad < 20; bad += 1) {
      const plan = await planBatch(items(20, [bad]), model(), { maxBisectRounds: 50 });
      expect(plan.failed.map((f) => [f.item.id, f.error.specCode])).toEqual([[bad, 72]]);
      expect(plan.rounds).toBeLessThanOrEqual(5);
      expect(plan.batches).toEqual([items(20).filter((i) => i.id !== bad)]);
      expect(plan.deferred).toEqual([]);
    }
    expect(bisectRounds(20)).toBe(5);
    expect(bisectRounds(1)).toBe(0);
  });

  it('three bad items are all removed', async () => {
    const port = model();
    const plan = await planBatch(items(20, [2, 11, 19]), port, { maxBisectRounds: 50 });
    expect(plan.failed.map((f) => f.item.id)).toEqual([2, 11, 19]);
    expect(plan.batches.flat().map((i) => i.id)).toEqual(
      items(20)
        .map((i) => i.id)
        .filter((id) => ![2, 11, 19].includes(id)),
    );
    expect(plan.rounds).toBeLessThanOrEqual(3 * bisectRounds(20));
  });

  it('stops at maxBisectRounds', async () => {
    const port = model();
    const plan = await planBatch(items(20, [7, 13]), port, { maxBisectRounds: 3 });
    expect(plan.rounds).toBe(3);
    expect(plan.batches).toEqual([]);
    expect(plan.failed).toEqual([]);
    expect(plan.deferred.map((i) => i.id)).toEqual(items(20).map((i) => i.id));
    const none = await planBatch(items(4, [1]), model(), { maxBisectRounds: 0 });
    expect(none.deferred.length).toBe(4);
  });

  it('blames the item the earlier transfers left short, not the largest one', async () => {
    const list: Item[] = [
      { id: 0, amount: 400n },
      { id: 1, amount: 500n },
      { id: 2, amount: 300n },
      { id: 3, amount: 100n },
    ];
    const plan = await planBatch(list, model({ balance: 1_000n }), { maxBisectRounds: 10 });
    expect(plan.failed.map((f) => [f.item.id, f.error.specName])).toEqual([
      [2, 'INSUFFICIENT_FUNDS'],
    ]);
    expect(plan.batches.map((b) => b.map((i) => i.id))).toEqual([[0, 1, 3]]);
  });

  it('events-limit failure splits into two halves and alerts', async () => {
    const port = model({ maxItems: 5 });
    const plan = await planBatch(items(10), port, { maxBisectRounds: 10 });
    expect(plan.batches.map((b) => b.map((i) => i.id))).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6, 7, 8, 9],
    ]);
    expect(plan.alerts).toEqual([{ kind: 'events_limit', size: 10 }]);
    expect(plan.rounds).toBe(0);
    expect(port.calls.map((c) => c.length)).toEqual([10, 5, 5]);
    const single = await planBatch(items(1), model({ maxItems: 0 }), { maxBisectRounds: 10 });
    expect(single.deferred.length).toBe(1);
  });

  it('an AGENT_REMOVED item is removed and the principal alerted', async () => {
    const removed = { code: 65, name: 'AGENT_REMOVED' } as const;
    const plan = await planBatch(items(6, [4], removed), model(), { maxBisectRounds: 10 });
    expect(plan.failed.map((f) => [f.item.id, f.error.specName, f.error.retryable])).toEqual([
      [4, 'AGENT_REMOVED', false],
    ]);
    expect(plan.alerts).toEqual([{ kind: 'agent_removed', item: items(6, [4], removed)[4] }]);
    expect(plan.batches.flat().map((i) => i.id)).toEqual([0, 1, 2, 3, 5]);
  });

  it('stops planning on a failure no item caused and refuses a bad bound', async () => {
    const port: BatchSimulationPort<Item> = {
      simulate: () => Promise.resolve({ ok: false, kind: 'error', error: new RpcTimeoutError() }),
    };
    await expect(planBatch(items(3), port, { maxBisectRounds: 3 })).rejects.toBeInstanceOf(
      RpcTimeoutError,
    );
    await expect(planBatch(items(3), model(), { maxBisectRounds: -1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(await planBatch([], model(), { maxBisectRounds: 3 })).toMatchObject({
      batches: [],
      simulations: 0,
    });
  });

  it('defers a batch whose prefix overflows the events limit mid search', async () => {
    let call = 0;
    const port: BatchSimulationPort<Item> = {
      simulate: () => {
        call += 1;
        return Promise.resolve(
          call === 1
            ? { ok: false, kind: 'refused', error: new MandateRuleError(72, 'TRANSFER_FAILED') }
            : { ok: false, kind: 'events_limit' },
        );
      },
    };
    const plan = await planBatch(items(4), port, { maxBisectRounds: 5 });
    expect(plan.deferred.length).toBe(4);
  });
});

describe('the Soroban events limit', () => {
  it('is recognised only by the resource limit with an events size message', () => {
    const limit = 'InvokeHostFunctionResourceLimitExceeded';
    expect(
      isEventsLimitFailure(limit, ['x total events size exceeds network config maximum']),
    ).toBe(true);
    expect(
      isEventsLimitFailure(limit, ['return value pushes events size above network config maximum']),
    ).toBe(true);
    expect(isEventsLimitFailure(limit, ['cpu instructions exceeded'])).toBe(false);
    expect(
      isEventsLimitFailure('InvokeHostFunctionTrapped', [
        'total events size exceeds network config maximum',
      ]),
    ).toBe(false);
  });
});
