// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the chain agnostic receipt reference (receipt-ref.ts).
 *
 *   ujira:tx:v1:{caip2}:{txHash}:{eventIndex}
 *
 * caip2 is one of NETWORK_IDS. txHash is lowercase hex: 64 characters on a
 * Stellar network, 0x followed by 64 on an EVM network. eventIndex is a
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

import { InvalidInputError, NETWORK_IDS, formatReceiptRef, parseReceiptRef } from './index.js';
import type { NetworkId } from './index.js';

const STELLAR_HASH = 'a'.repeat(64);
const EVM_HASH = `0x${'b'.repeat(64)}`;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('receipt references', () => {
  it('lists the four launch networks', () => {
    expect([...NETWORK_IDS]).toEqual([
      'stellar:pubnet',
      'stellar:testnet',
      'eip155:42220',
      'eip155:11142220',
    ]);
    expect(Object.isFrozen(NETWORK_IDS)).toBe(true);
  });

  it('formats and parses a Celo and a Stellar reference', () => {
    const celo = formatReceiptRef({ network: 'eip155:42220', txHash: EVM_HASH, eventIndex: 7 });
    expect(celo).toBe(`ujira:tx:v1:eip155:42220:${EVM_HASH}:7`);
    expect(parseReceiptRef(celo)).toEqual({
      network: 'eip155:42220',
      txHash: EVM_HASH,
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
    ['an unknown network', `ujira:tx:v1:eip155:1:${EVM_HASH}:1`],
    ['another prefix', `ujira:rx:v1:eip155:42220:${EVM_HASH}:1`],
    ['another version', `ujira:tx:v2:eip155:42220:${EVM_HASH}:1`],
    ['a Stellar hash on Celo', `ujira:tx:v1:eip155:42220:${STELLAR_HASH}:1`],
    ['a Celo hash on Stellar', `ujira:tx:v1:stellar:testnet:${EVM_HASH}:1`],
    ['an uppercase hash', `ujira:tx:v1:stellar:testnet:${'A'.repeat(64)}:1`],
    ['a short hash', `ujira:tx:v1:stellar:testnet:${'a'.repeat(63)}:1`],
    ['a negative index', `ujira:tx:v1:eip155:42220:${EVM_HASH}:-1`],
    ['a leading zero', `ujira:tx:v1:eip155:42220:${EVM_HASH}:01`],
    ['an index past u32', `ujira:tx:v1:eip155:42220:${EVM_HASH}:4294967296`],
    ['a missing index', `ujira:tx:v1:eip155:42220:${EVM_HASH}`],
    ['a trailing colon', `ujira:tx:v1:eip155:42220:${EVM_HASH}:1:`],
    ['whitespace', ` ujira:tx:v1:eip155:42220:${EVM_HASH}:1`],
    ['an empty string', ''],
    ['a missing network', `ujira:tx:v1:${EVM_HASH}:1`],
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
      { network: 'eip155:1' as NetworkId, txHash: EVM_HASH, eventIndex: 0 },
      { network: 'eip155:42220', txHash: STELLAR_HASH, eventIndex: 0 },
      { network: 'eip155:42220', txHash: EVM_HASH, eventIndex: -1 },
      { network: 'eip155:42220', txHash: EVM_HASH, eventIndex: 1.5 },
      { network: 'eip155:42220', txHash: EVM_HASH, eventIndex: 2 ** 32 },
    ];
    for (const parts of bad) {
      expect(thrown(() => formatReceiptRef(parts))).toBeInstanceOf(InvalidInputError);
    }
    for (const parts of [null, undefined, 'ref', Object.create({ network: 'eip155:42220' })]) {
      expect(thrown(() => formatReceiptRef(parts as never))).toBeInstanceOf(InvalidInputError);
    }
  });
});
