// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the routing document (config.ts).
 *
 * parseRoutingConfig(input) validates the whole document and returns a deep
 * frozen RoutingConfig, or throws RoutingConfigInvalidError whose issues are
 * "path (reason)" strings that never quote a value.
 *
 * - schemaVersion is 1. rails, corridors and networks are required.
 * - networks is validated by the chain adapter, so RPC endpoints must be
 *   secret references and a literal URL with a key in it is refused.
 * - A rail has a unique id, a known network that the document configures, a
 *   known rail kind, an optional provider name and an enabled flag.
 * - A corridor is one country, payout method and delivery currency, with a
 *   strategy and one to sixteen candidate rails, each named once and each
 *   defined in rails.
 * - Every object is strict, so an unknown field (where a pasted secret
 *   would land) is refused, and every string is a constrained name or code.
 * - The input must be JSON data: plain objects and arrays, strings, finite
 *   numbers, booleans and null, own data properties only, at most 32 deep.
 */

import { describe, expect, it } from 'vitest';

import { MAX_MARKED_VERSION, TESTNET, markedDocument, routingDocument } from '../test/fixtures.js';
import type { TestDocument } from '../test/fixtures.js';
import { ROUTING_SCHEMA_VERSION, RoutingConfigInvalidError, parseRoutingConfig } from './index.js';

function refusal(input: unknown): RoutingConfigInvalidError {
  try {
    parseRoutingConfig(input);
  } catch (err) {
    if (err instanceof RoutingConfigInvalidError) return err;
    throw err;
  }
  throw new Error('expected the document to be refused');
}

function edited(change: (doc: TestDocument) => void): TestDocument {
  const doc = routingDocument();
  change(doc);
  return doc;
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

// A marker standing in for a pasted credential. It is plainly fake so the
// secret scanner has nothing to flag, and distinctive enough to search for.
const LEAKED_KEY = 'pasted-credential-marker';

it('a document with an unknown rail is refused', () => {
  const doc = edited((d) => {
    d.corridors[0]?.candidates.push({ rail: 'anchor_z', priority: 3 });
  });
  const err = refusal(doc);
  expect(err.code).toBe('ROUTING_CONFIG_INVALID');
  expect(err.issues).toEqual(['corridors.0.candidates.2.rail (unknown_rail)']);
});

it('a literal RPC key is rejected, a secretRef is accepted', () => {
  const literal = `https://rpc.example.com/v1/${LEAKED_KEY}`;
  const bad = edited((d) => {
    const network = d.networks[TESTNET];
    if (network) network['rpc'] = [{ url: literal, weight: 1 }];
  });
  const err = refusal(bad);
  expect(err.issues.some((issue) => issue.startsWith(`networks.${TESTNET}.rpc.0.url`))).toBe(true);
  const printed = JSON.stringify({ message: err.message, issues: err.issues, stack: err.stack });
  expect(printed).not.toContain(LEAKED_KEY);
  expect(printed).not.toContain('rpc.example.com');

  const good = edited((d) => {
    const network = d.networks[TESTNET];
    if (network) network['rpc'] = [{ url: 'secretRef:testnet_rpc_backup', weight: 1 }];
  });
  expect(parseRoutingConfig(good).networks[TESTNET]?.rpc).toEqual([
    { url: 'secretRef:testnet_rpc_backup', weight: 1 },
  ]);
});

describe('parseRoutingConfig', () => {
  it('accepts a valid document and returns a deep frozen snapshot', () => {
    const config = parseRoutingConfig(routingDocument());
    expect(config.schemaVersion).toBe(ROUTING_SCHEMA_VERSION);
    expect(config.rails.map((r) => r.id)).toEqual(['anchor_a', 'anchor_b', 'wallet']);
    expect(config.corridors).toHaveLength(3);
    expect(config.corridors[0]?.candidates).toEqual([
      { rail: 'anchor_a', priority: 1 },
      { rail: 'anchor_b', priority: 2 },
    ]);
    // Network amounts come back as exact integers, never numbers.
    expect(config.networks[TESTNET]?.feeSponsor.maxFeePerTxStroops).toBe(1_000_000n);
    expect(isDeepFrozen(config)).toBe(true);
  });

  it('does not share objects with the input', () => {
    const doc = routingDocument();
    const config = parseRoutingConfig(doc);
    doc.rails[0] = { ...doc.rails[0], enabled: false };
    expect(config.rails[0]?.enabled).toBe(true);
    expect(Object.isFrozen(doc)).toBe(false);
  });

  it('accepts a rail without a provider and many corridors', () => {
    const config = parseRoutingConfig(markedDocument(MAX_MARKED_VERSION));
    expect(config.corridors).toHaveLength(MAX_MARKED_VERSION);
    expect(config.rails.find((r) => r.id === 'wallet')?.provider).toBeUndefined();
  });

  it('keeps a rail on a configured network that is switched off', () => {
    const doc = edited((d) => {
      const network = d.networks[TESTNET];
      if (network) network['enabled'] = false;
    });
    expect(parseRoutingConfig(doc).networks[TESTNET]?.enabled).toBe(false);
  });

  it('accepts a document with no corridors yet', () => {
    expect(parseRoutingConfig(edited((d) => (d.corridors = []))).corridors).toEqual([]);
  });

  it.each([
    [
      'another schema version',
      (d: TestDocument) => (d.schemaVersion = 2),
      'schemaVersion (invalid_value)',
    ],
    ['no rails', (d: TestDocument) => (d.rails = []), 'rails (too_small)'],
    [
      'an unknown rail kind',
      (d: TestDocument) => {
        if (d.rails[0]) d.rails[0]['rail'] = 'stellar.sep24';
      },
      'rails.0.rail (unknown_rail_kind)',
    ],
    [
      'an unknown network',
      (d: TestDocument) => {
        if (d.rails[0]) d.rails[0]['network'] = 'stellar:futurenet';
      },
      'rails.0.network (unknown_network)',
    ],
    [
      'a rail name with capitals',
      (d: TestDocument) => {
        if (d.rails[2]) d.rails[2]['id'] = 'Wallet';
      },
      'rails.2.id (invalid_format)',
    ],
    [
      'a duplicate rail id',
      (d: TestDocument) => {
        d.rails.push({ ...d.rails[0], provider: 'anchor-b.example' });
      },
      'rails.3.id (duplicate_rail)',
    ],
    [
      'a lower case country',
      (d: TestDocument) => {
        if (d.corridors[0]) d.corridors[0]['country'] = 'ng';
      },
      'corridors.0.country (invalid_format)',
    ],
    [
      'an unknown payout method',
      (d: TestDocument) => {
        if (d.corridors[0]) d.corridors[0]['method'] = 'cheque';
      },
      'corridors.0.method (invalid_value)',
    ],
    [
      'an unknown currency',
      (d: TestDocument) => {
        if (d.corridors[0]) d.corridors[0]['currency'] = 'XAU';
      },
      'corridors.0.currency (unknown_currency)',
    ],
    [
      'an unknown strategy',
      (d: TestDocument) => {
        if (d.corridors[0]) d.corridors[0]['strategy'] = 'fastest';
      },
      'corridors.0.strategy (invalid_value)',
    ],
    [
      'a corridor without candidates',
      (d: TestDocument) => {
        if (d.corridors[0]) d.corridors[0].candidates = [];
      },
      'corridors.0.candidates (too_small)',
    ],
    [
      'a fractional priority',
      (d: TestDocument) => {
        if (d.corridors[0]?.candidates[0]) d.corridors[0].candidates[0]['priority'] = 1.5;
      },
      'corridors.0.candidates.0.priority (invalid_type)',
    ],
    [
      'a negative priority',
      (d: TestDocument) => {
        if (d.corridors[0]?.candidates[0]) d.corridors[0].candidates[0]['priority'] = -1;
      },
      'corridors.0.candidates.0.priority (too_small)',
    ],
    [
      'a rail named twice in one corridor',
      (d: TestDocument) => {
        d.corridors[0]?.candidates.push({ rail: 'anchor_a', priority: 9 });
      },
      'corridors.0.candidates.2.rail (duplicate_candidate)',
    ],
    [
      'the same corridor twice',
      (d: TestDocument) => {
        const first = d.corridors[0];
        if (first) d.corridors.push({ ...first, strategy: 'priority' });
      },
      'corridors.3 (duplicate_corridor)',
    ],
    [
      'a rail on a network the document does not configure',
      (d: TestDocument) => {
        if (d.rails[0]) d.rails[0]['network'] = 'stellar:pubnet';
      },
      'rails.0.network (network_not_configured)',
    ],
    [
      'no networks section',
      (d: TestDocument) => {
        Reflect.deleteProperty(d, 'networks');
      },
      'networks (invalid_type)',
    ],
  ])('refuses %s', (_label, change, issue) => {
    expect(refusal(edited(change)).issues).toEqual([issue]);
  });

  it('refuses an unknown field without naming it or quoting its value', () => {
    const doc = edited((d) => {
      if (d.rails[0]) d.rails[0][LEAKED_KEY] = LEAKED_KEY;
      Object.assign(d, { credential: LEAKED_KEY });
    });
    const err = refusal(doc);
    expect([...err.issues].sort()).toEqual([
      'document (unrecognized_keys)',
      'rails.0 (unrecognized_keys)',
    ]);
    expect(JSON.stringify(err.issues)).not.toContain(LEAKED_KEY);
  });

  it('reports network and routing problems together', () => {
    const doc = edited((d) => {
      if (d.rails[0]) d.rails[0]['rail'] = 'unknown';
      const network = d.networks[TESTNET];
      if (network) network['maxEndpointLagSeconds'] = 0;
    });
    expect(refusal(doc).issues).toEqual([
      'rails.0.rail (unknown_rail_kind)',
      `networks.${TESTNET}.maxEndpointLagSeconds (too_small)`,
    ]);
  });

  it('lists at most twenty issues', () => {
    const doc = edited((d) => {
      d.rails = Array.from({ length: 30 }, () => ({ id: 'X' }));
    });
    expect(refusal(doc).issues).toHaveLength(20);
  });

  it.each([
    ['null', null],
    ['a string', 'routing'],
    ['an array', []],
  ])('refuses %s as a document', (_label, input) => {
    expect(refusal(input).issues).toContain('document (invalid_type)');
  });

  class Box {
    readonly value = 1;
  }

  const nested = (levels: number): unknown => {
    let node: unknown = 'leaf';
    for (let i = 0; i < levels; i += 1) node = [node];
    return node;
  };

  it.each([
    ['a bigint', () => Object.assign(routingDocument(), { extra: 1n })],
    ['an undefined value', () => Object.assign(routingDocument(), { extra: undefined })],
    ['a function', () => Object.assign(routingDocument(), { extra: () => 1 })],
    ['a non finite number', () => Object.assign(routingDocument(), { extra: Number.NaN })],
    ['a class instance', () => Object.assign(routingDocument(), { extra: new Box() })],
    ['a date', () => Object.assign(routingDocument(), { extra: new Date(0) })],
    ['a symbol key', () => Object.assign(routingDocument(), { [Symbol('x')]: 1 })],
    [
      'a getter',
      () =>
        Object.defineProperty(routingDocument(), 'schemaVersion', {
          get: () => 1,
          enumerable: true,
        }),
    ],
    ['nesting deeper than 32', () => Object.assign(routingDocument(), { extra: nested(40) })],
  ])('refuses %s, which JSON cannot hold', (_label, build) => {
    expect(refusal(build()).issues).toEqual(['document (not_json)']);
  });

  it('accepts JSON nested to the limit before the schema looks at it', () => {
    const err = refusal(Object.assign(routingDocument(), { extra: nested(30) }));
    expect(err.issues).toEqual(['document (unrecognized_keys)']);
  });

  it('accepts a null prototype object', () => {
    const doc = Object.assign(Object.create(null) as object, routingDocument());
    expect(parseRoutingConfig(doc).rails).toHaveLength(3);
  });
});
