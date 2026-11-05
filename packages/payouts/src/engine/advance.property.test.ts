// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Whatever goes wrong and whenever, a payout is paid once or not at all: the job dies
// after any write, the chain times out after a transaction landed, the signer and the
// network drop out, and the job simply runs again each time.

import type { Payout, PayoutAttempt } from '@ujira/db';
import { payoutAttempts } from '@ujira/db';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RetryableJobError } from '../worker/errors.js';
import { workerHarness, type WorkerHarness } from '../worker/testing/support.js';
import {
  engineWorld,
  Killed,
  killing,
  ONE_USDC,
  seedTenant,
  TENANT,
  usdc,
  type EngineWorld,
} from './testing/world.js';

let harness: WorkerHarness;

beforeAll(async () => {
  harness = await workerHarness(import.meta.url);
  await seedTenant(harness);
});

afterAll(async () => {
  await harness.close();
});

type Fault =
  | { readonly kind: 'kill'; readonly at: number }
  | { readonly kind: 'timeout_after_landing' }
  | { readonly kind: 'chain_down' }
  | { readonly kind: 'signer_down' }
  | { readonly kind: 'none' };

const faultArbitrary: fc.Arbitrary<Fault> = fc.oneof(
  fc.record({ kind: fc.constant('kill' as const), at: fc.integer({ min: 1, max: 12 }) }),
  fc.constant({ kind: 'timeout_after_landing' as const }),
  fc.constant({ kind: 'chain_down' as const }),
  fc.constant({ kind: 'signer_down' as const }),
  fc.constant({ kind: 'none' as const }),
);

// One run under one fault. A job that dies, or that the chain turns back, simply runs
// again next time.
async function runUnder(world: EngineWorld, payout: Payout, fault: Fault): Promise<void> {
  const faults = world.h.faults;
  const deps = fault.kind === 'kill' ? killing(world.deps, fault.at).deps : world.deps;
  if (fault.kind === 'timeout_after_landing') faults?.timeoutAfterLanding(1);
  if (fault.kind === 'chain_down') faults?.chainDown(true);
  if (fault.kind === 'signer_down') faults?.signerDown(true);
  try {
    await world.run(payout, { deps });
  } catch (error) {
    const expected = error instanceof Killed || error instanceof RetryableJobError;
    if (!expected && !isAdapterShaped(error)) throw error;
  } finally {
    if (fault.kind === 'chain_down') faults?.chainDown(false);
    if (fault.kind === 'signer_down') faults?.signerDown(false);
  }
  await world.h.advance(6n);
}

function isAdapterShaped(error: unknown): boolean {
  return error instanceof Error && 'retryable' in error;
}

describe('crashes and retries', () => {
  it('never pay twice', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(faultArbitrary, { maxLength: 8 }), async (faults) => {
        const world = await engineWorld(harness);
        const before = await world.balanceOfRecipient();
        const payout = await world.payout(`property-${crypto.randomUUID()}`, usdc(ONE_USDC));
        for (const fault of faults) await runUnder(world, payout, fault);

        const attemptsOf = async (): Promise<readonly PayoutAttempt[]> =>
          harness.db
            .tenant(TENANT)
            .transaction(async (tx) => payoutAttempts.forPayout(tx, payout.id));
        const paidWhileFaulted = (await world.balanceOfRecipient()) - before;
        expect([0n, ONE_USDC]).toContain(paidWhileFaulted);

        // With the faults gone it finishes, and still only once.
        const ended = await world.drive(payout, { runs: 25 });
        expect(ended.status).toBe('paid');
        const attempts = await attemptsOf();
        expect(attempts.filter((attempt) => attempt.status === 'final')).toHaveLength(1);
        const executed = attempts.reduce(
          (sum, attempt) => sum + world.executed(attempt.onChainPayoutId ?? ''),
          0,
        );
        expect(executed).toBe(1);
        expect((await world.balanceOfRecipient()) - before).toBe(ONE_USDC);
      }),
      { numRuns: 12 },
    );
  }, 280_000);
});
