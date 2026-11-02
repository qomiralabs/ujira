// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ATTESTATION_BREAKERS, ATTESTATION_STEPS, attestationWorld } from './testing/index.js';
import { ATTESTATION_REFUSAL_REASONS } from './types.js';

const MODES = ['attested', 'both'] as const;

describe('every check refuses when its input is broken', () => {
  it('every step and every refusal reason has a breaker', () => {
    expect(new Set(ATTESTATION_BREAKERS.map((breaker) => breaker.step))).toEqual(
      new Set(ATTESTATION_STEPS),
    );
    expect(new Set(ATTESTATION_BREAKERS.map((breaker) => breaker.reason))).toEqual(
      new Set(ATTESTATION_REFUSAL_REASONS),
    );
  });

  it('the unbroken world attests in every mode, rail and leg', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...MODES),
        fc.boolean(),
        fc.integer({ min: 0, max: 255 }),
        async (mode, kycRail, legIndex) => {
          const w = attestationWorld({ mode, kycRail, legIndex });
          const result = await w.attest();
          expect(result.attested).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('breaking each input in turn gives the matching reason, and nothing is logged or signed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...MODES),
        fc.boolean(),
        fc.integer({ min: 0, max: 255 }),
        async (mode, kycRail, legIndex) => {
          for (const breaker of ATTESTATION_BREAKERS) {
            if (breaker.mode !== undefined && breaker.mode !== mode) continue;
            const w = attestationWorld({ mode, kycRail, legIndex });
            breaker.apply(w);
            expect(await w.attest(), breaker.name).toEqual({
              attested: false,
              reason: breaker.reason,
              detail: breaker.detail,
            });
            expect(w.log.events, breaker.name).toEqual([]);
            expect(w.log.rows(w.scope), breaker.name).toEqual([]);
            expect(w.attester.signed, breaker.name).toEqual([]);
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
