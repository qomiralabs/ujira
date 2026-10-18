// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the chain agnostic receipt reference (receipt-ref.ts).
 *
 *   ujira:tx:v1:{caip2}:{txHash}:{eventIndex}
 *
 * caip2 is one of NETWORK_IDS. txHash follows the format of the network's
 * namespace in RECEIPT_HASH_FORMATS: 64 lowercase hex characters for
 * Stellar. Every namespace in CHAIN_NAMESPACES has an entry. eventIndex is a
 * canonical decimal u32 (no sign, no leading zero, at most 4294967295).
 * Parsing splits from the right, because caip2 itself holds a colon, and
 * refuses input longer than 128 characters before looking at it.
 *
 * formatReceiptRef({ network, txHash, eventIndex }) validates and returns
 * the branded ReceiptRef. parseReceiptRef(text) returns the three parts.
 * Anything malformed throws InvalidInputError with a fixed message and an
 * issue naming what was wrong (receiptRef.network (unknown), and so on),
 * never the input. formatReceiptRef takes a plain object; null or anything
 * else throws InvalidInputError too.
 */

import { describe, expect, it } from 'vitest';

import {
  CHAIN_NAMESPACES,
  InvalidInputError,
  NETWORK_IDS,
  RECEIPT_HASH_FORMATS,
  formatReceiptRef,
  parseReceiptRef,
} from './index.js';
import type { NetworkId } from './index.js';

const STELLAR_HASH = 'a'.repeat(64);
const H = 'b'.repeat(64);
// The right length with a 0x prefix, which no Stellar hash carries.
const PREFIXED_HASH = `0x${'b'.repeat(64)}`;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('receipt references', () => {
  it('lists the two launch networks', () => {
    expect([...NETWORK_IDS]).toEqual(['stellar:pubnet', 'stellar:testnet']);
    expect(Object.isFrozen(NETWORK_IDS)).toBe(true);
  });

  it('hash format comes from the namespace table', () => {
    expect(Object.keys(RECEIPT_HASH_FORMATS).sort()).toEqual([...CHAIN_NAMESPACES].sort());
    expect(Object.isFrozen(RECEIPT_HASH_FORMATS)).toBe(true);
    for (const network of NETWORK_IDS) {
      const format = RECEIPT_HASH_FORMATS[network.split(':')[0] as 'stellar'];
      expect(format.test(H)).toBe(true);
      expect(format.test(PREFIXED_HASH)).toBe(false);
      const ref = formatReceiptRef({ network, txHash: H, eventIndex: 3 });
      expect(parseReceiptRef(ref)).toEqual({ network, txHash: H, eventIndex: 3 });
    }
  });

  it('formats and parses a testnet and a pubnet reference', () => {
    const testnet = formatReceiptRef({ network: 'stellar:testnet', txHash: H, eventIndex: 7 });
    expect(testnet).toBe(`ujira:tx:v1:stellar:testnet:${H}:7`);
    expect(parseReceiptRef(testnet)).toEqual({
      network: 'stellar:testnet',
      txHash: H,
      eventIndex: 7,
    });
    const stellar = formatReceiptRef({
      network: 'stellar:pubnet',
      txHash: STELLAR_HASH,
      eventIndex: 0,
    });
    expect(stellar).toBe(`ujira:tx:v1:stellar:pubnet:${STELLAR_HASH}:0`);
    expect(parseReceiptRef(stellar).network).toBe('stellar:pubnet');
  });

  it.each([
    ['an unknown network', `ujira:tx:v1:stellar:futurenet:${H}:1`],
    ['another prefix', `ujira:rx:v1:stellar:testnet:${H}:1`],
    ['another version', `ujira:tx:v2:stellar:testnet:${H}:1`],
    ['a 0x prefixed hash', `ujira:tx:v1:stellar:testnet:${PREFIXED_HASH}:1`],
    ['an uppercase hash', `ujira:tx:v1:stellar:testnet:${'A'.repeat(64)}:1`],
    ['a short hash', `ujira:tx:v1:stellar:testnet:${'a'.repeat(63)}:1`],
    ['a negative index', `ujira:tx:v1:stellar:testnet:${H}:-1`],
    ['a leading zero', `ujira:tx:v1:stellar:testnet:${H}:01`],
    ['an index past u32', `ujira:tx:v1:stellar:testnet:${H}:4294967296`],
    ['a missing index', `ujira:tx:v1:stellar:testnet:${H}`],
    ['a trailing colon', `ujira:tx:v1:stellar:testnet:${H}:1:`],
    ['whitespace', ` ujira:tx:v1:stellar:testnet:${H}:1`],
    ['an empty string', ''],
    ['a missing network', `ujira:tx:v1:${H}:1`],
    ['an empty network and hash', 'ujira:tx:v1::1'],
    ['the prefix alone', 'ujira:tx:v1:'],
  ])('refuses %s', (_label, text) => {
    expect(thrown(() => parseReceiptRef(text))).toBeInstanceOf(InvalidInputError);
  });

  it('refuses a huge input before parsing and never echoes it', () => {
    const huge = `ujira:tx:v1:${'x'.repeat(1_000_000)}`;
    const err = thrown(() => parseReceiptRef(huge));
    expect(err).toBeInstanceOf(InvalidInputError);
    expect((err as Error).message.length).toBeLessThan(200);
    expect((err as Error).message).not.toContain('xxxx');
    // Refused by the length cap, before any splitting or matching.
    expect((err as InvalidInputError).issues).toEqual(['receiptRef (too_long)']);
  });

  it('refuses non strings and bad parts when formatting', () => {
    expect(thrown(() => parseReceiptRef(1 as never))).toBeInstanceOf(InvalidInputError);
    const bad: { network: NetworkId; txHash: string; eventIndex: number }[] = [
      { network: 'stellar:futurenet' as NetworkId, txHash: H, eventIndex: 0 },
      { network: 'stellar:testnet', txHash: PREFIXED_HASH, eventIndex: 0 },
      { network: 'stellar:testnet', txHash: H, eventIndex: -1 },
      { network: 'stellar:testnet', txHash: H, eventIndex: 1.5 },
      { network: 'stellar:testnet', txHash: H, eventIndex: 2 ** 32 },
    ];
    for (const parts of bad) {
      expect(thrown(() => formatReceiptRef(parts))).toBeInstanceOf(InvalidInputError);
    }
    const own = { network: 'stellar:testnet', txHash: H, eventIndex: 1 };
    for (const parts of [
      null,
      undefined,
      'ref',
      Object.create({ network: 'stellar:testnet' }),
      // Own fields that would pass, on an object that is not plain.
      Object.assign(new Date(0), own),
      {},
      {
        ...own,
        get network() {
          return 'stellar:testnet';
        },
      },
    ]) {
      expect(thrown(() => formatReceiptRef(parts as never))).toBeInstanceOf(InvalidInputError);
    }
  });
});
