// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The contract for receipt references is documented at the top of
// receipt-ref.test.ts.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidInputError, NETWORK_IDS, formatReceiptRef, parseReceiptRef } from './index.js';

// Fixed seed so a failure reproduces on every machine.
const RUNS = { seed: 0x7ec1, numRuns: 200 } as const;

const hexDigit = fc.integer({ min: 0, max: 15 }).map((n) => n.toString(16));
const hex = (length: number) => fc.string({ unit: hexDigit, minLength: length, maxLength: length });

const partsArb = fc.constantFrom(...NETWORK_IDS).chain((network) =>
  fc.record({
    network: fc.constant(network),
    txHash: hex(64),
    eventIndex: fc.oneof(
      fc.integer({ min: 0, max: 2 ** 32 - 1 }),
      fc.constantFrom(0, 1, 2 ** 32 - 1),
    ),
  }),
);

describe('receipt reference properties', () => {
  it('parse(format(parts)) returns the parts for every network', () => {
    fc.assert(
      fc.property(partsArb, (parts) => {
        const ref = formatReceiptRef(parts);
        expect(parseReceiptRef(ref)).toEqual(parts);
        expect(formatReceiptRef(parseReceiptRef(ref))).toBe(ref);
      }),
      RUNS,
    );
  });

  it('any other string either parses to a reference that formats back, or throws InvalidInputError', () => {
    const textArb = fc.oneof(
      fc.string({ maxLength: 160 }),
      partsArb
        .map((p) => formatReceiptRef(p))
        .chain((ref) =>
          fc
            .integer({ min: 0, max: ref.length - 1 })
            .chain((i) =>
              fc.string({ maxLength: 2 }).map((s) => ref.slice(0, i) + s + ref.slice(i + 1)),
            ),
        ),
    );
    fc.assert(
      fc.property(textArb, (text) => {
        let parsed: ReturnType<typeof parseReceiptRef> | undefined;
        try {
          parsed = parseReceiptRef(text);
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidInputError);
          return;
        }
        expect(formatReceiptRef(parsed)).toBe(text);
      }),
      RUNS,
    );
  });
});
