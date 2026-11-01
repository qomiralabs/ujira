// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ATTESTATION_BREAKERS, ATTESTATION_STEPS, attestationWorld } from './testing/index.js';
import type { Breaker } from './testing/index.js';

// One breaker per check, in check order. They patch different rows, or the
// same rows in different fields, so any set of them can be applied together.
const BY_STEP: readonly Breaker[] = ATTESTATION_BREAKERS.filter((b) => b.representative);

async function firstReason(broken: readonly Breaker[], mode: 'attested' | 'both') {
  const w = attestationWorld({ mode });
  for (const breaker of broken) breaker.apply(w);
  const result = await w.attest();
  expect(w.log.events).toEqual([]);
  expect(w.attester.signed).toEqual([]);
  return result;
}

describe('the order is fixed', () => {
  it('there is one composable breaker for every check, in check order', () => {
    expect(BY_STEP.map((breaker) => breaker.step)).toEqual([...ATTESTATION_STEPS]);
  });

  it('the first failing check decides the reason', async () => {
    // Every pair, earlier check first, then applied in both orders.
    for (const [i, earlier] of BY_STEP.entries()) {
      for (const later of BY_STEP.slice(i + 1)) {
        const expected = { attested: false, reason: earlier.reason, detail: earlier.detail };
        const label = `${earlier.name} then ${later.name}`;
        expect(await firstReason([earlier, later], 'attested'), label).toEqual(expected);
        expect(await firstReason([later, earlier], 'both'), label).toEqual(expected);
      }
    }
    // And any larger set, applied in any order.
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray([...BY_STEP], { minLength: 1 }),
        fc.constantFrom('attested' as const, 'both' as const),
        async (broken, mode) => {
          const first = BY_STEP.find((breaker) => broken.includes(breaker));
          if (first === undefined) throw new Error('fast-check gave an empty set');
          expect(await firstReason(broken, mode)).toEqual({
            attested: false,
            reason: first.reason,
            detail: first.detail,
          });
        },
      ),
      { numRuns: 40 },
    );
  });
});
