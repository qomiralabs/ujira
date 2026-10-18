// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for EIP-55 address checks (eip55.ts). isEip55Address(text) is
 * true only for 0x plus 40 hex characters whose letter case matches the
 * EIP-55 checksum of the address. The hash comes from @noble/hashes; the
 * published Keccak-256 digests below pin that it is the original Keccak
 * padding Ethereum uses, not NIST SHA3-256.
 */

import { createHash } from 'node:crypto';

import { keccak_256 as keccak256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';

import { isEip55Address } from './eip55.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('keccak256', () => {
  it.each([
    ['', 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    ['abc', '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
    [
      'The quick brown fox jumps over the lazy dog',
      '4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15',
    ],
  ])('hashes %j to the published digest', (input, digest) => {
    expect(hex(keccak256(text(input)))).toBe(digest);
  });

  it('crosses the 136 byte block boundary correctly', () => {
    // 135, 136 and 137 bytes take one, two and two blocks of padding.
    expect(hex(keccak256(new Uint8Array(135)))).toHaveLength(64);
    expect(hex(keccak256(new Uint8Array(136)))).not.toBe(hex(keccak256(new Uint8Array(135))));
    expect(hex(keccak256(new Uint8Array(200).fill(0x61)))).toBe(
      hex(keccak256(text('a'.repeat(200)))),
    );
  });

  it('differs from NIST SHA3-256, which pads differently', () => {
    const sha3 = createHash('sha3-256').update('abc').digest('hex');
    expect(hex(keccak256(text('abc')))).not.toBe(sha3);
  });
});

describe('isEip55Address', () => {
  it.each([
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    // No letters at all, so there is no case to check.
    '0x1234567890123456789012345678901234567890',
  ])('accepts %s', (address) => {
    expect(isEip55Address(address)).toBe(true);
  });

  it.each([
    ['one flipped letter', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'],
    ['all lowercase', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'],
    ['all uppercase', '0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED'],
    ['too short', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe'],
    ['an uppercase prefix', '0X5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
    ['no prefix', '5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
    ['a non hex character', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeg'],
  ])('refuses %s', (_label, address) => {
    expect(isEip55Address(address)).toBe(false);
  });
});
