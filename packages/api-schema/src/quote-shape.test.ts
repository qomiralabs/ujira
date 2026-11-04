// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The price of XLM measures a shortfall inside UJIRA and goes no further.
// Every response shape a customer can see comes through this contract, so a
// field carrying that rate would show up here first.

import { describe, expect, it } from 'vitest';

import { generateFixtures } from './fixtures/index.js';
import { buildOpenApiDocument } from './index.js';

const FORBIDDEN = /xlm|nativeRate|native_rate|shortfall/i;

function keysOf(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) keysOf(item, found);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      keysOf(value, found);
    }
  }
  return found;
}

describe('the customer contract', () => {
  it('quotes and receipts carry no XLM rate field', () => {
    const doc = buildOpenApiDocument() as { components: { schemas: Record<string, unknown> } };
    const declared = [...keysOf(doc.components.schemas)].filter((key) => FORBIDDEN.test(key));
    expect(declared).toEqual([]);

    const served = [...keysOf(generateFixtures({ seed: 7, payouts: 50 }))].filter((key) =>
      FORBIDDEN.test(key),
    );
    expect(served).toEqual([]);
  });
});
