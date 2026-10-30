// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the strkey codecs (codecs/strkey.ts, exported from the
 * @ujira/chain-adapter/codecs subpath).
 *
 * decodeAccountAddress(address) returns the 32 byte ed25519 key a G address
 * carries; encodeAccountAddress(key) is its inverse. isAccountAddress and
 * isContractAddress check the version byte and the CRC16 checksum. Anything
 * else throws InvalidInputError naming the argument, never the value.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import * as codecs from './index.js';
import { STRKEY_VERSION, encodeStrkey, isStrkey } from './strkey.js';

const { decodeAccountAddress, encodeAccountAddress, isAccountAddress, isContractAddress } = codecs;

// The destination and the mandate of the worked attestation example in the
// contract spec, with the key and contract ID bytes it lists.
const DESTINATION = 'GDTYAUMMX45E2SU2Q7JRJHCXDIYTEUAXVBHZ7DVCVXZGMAKMWFL7SOY4';
const DESTINATION_ED25519 = 'e780518cbf3a4d4a9a87d3149c571a31325017a84f9f8ea2adf266014cb157f9';
const MANDATE = 'CDUKSTCG3XKTPTHMNRJZIW23J3T5DKHASDPQ3CIRKQ4YJH3PDOFFULZA';
// Circle's testnet USDC issuer.
const CIRCLE_TESTNET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('strkey codecs', () => {
  it('decodes the spec example to its key bytes and back', () => {
    expect(Buffer.from(decodeAccountAddress(DESTINATION)).toString('hex')).toBe(
      DESTINATION_ED25519,
    );
    expect(encodeAccountAddress(Buffer.from(DESTINATION_ED25519, 'hex'))).toBe(DESTINATION);
    expect(encodeAccountAddress(decodeAccountAddress(CIRCLE_TESTNET))).toBe(CIRCLE_TESTNET);
  });

  it('tells accounts and contracts apart', () => {
    expect(isAccountAddress(DESTINATION)).toBe(true);
    expect(isContractAddress(DESTINATION)).toBe(false);
    expect(isContractAddress(MANDATE)).toBe(true);
    expect(isAccountAddress(MANDATE)).toBe(false);
  });

  it('round trips any key', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (key) => {
        const address = encodeAccountAddress(key);
        expect(address).toMatch(/^G[A-Z2-7]{55}$/);
        expect(isAccountAddress(address)).toBe(true);
        expect(decodeAccountAddress(address)).toEqual(key);
      }),
    );
  });

  it('refuses anything but a well formed account address', () => {
    const lastFlipped = `${DESTINATION.slice(0, -1)}${DESTINATION.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of [
      MANDATE,
      DESTINATION.toLowerCase(),
      lastFlipped,
      DESTINATION.slice(1),
      `${DESTINATION}A`,
      '',
      7,
    ]) {
      expect(isAccountAddress(bad as string)).toBe(false);
      const err = thrown(() => decodeAccountAddress(bad as string));
      expect(err).toBeInstanceOf(InvalidInputError);
      expect((err as InvalidInputError).issues).toEqual(['address (invalid)']);
    }
  });

  it('refuses a key that is not 32 bytes', () => {
    for (const bad of [new Uint8Array(31), new Uint8Array(33), [...new Uint8Array(32)], 'key']) {
      const err = thrown(() => encodeAccountAddress(bad as Uint8Array));
      expect(err).toBeInstanceOf(InvalidInputError);
      expect((err as InvalidInputError).issues).toEqual(['publicKey (invalid_length)']);
    }
  });

  it('checks the version byte of every kind', () => {
    // Built at run time, so no seed shaped literal sits in the source.
    const seed = encodeStrkey(STRKEY_VERSION.seed, new Uint8Array(32).fill(7));
    expect(seed).toMatch(/^S/);
    expect(isStrkey(seed, STRKEY_VERSION.seed)).toBe(true);
    expect(isAccountAddress(seed)).toBe(false);
    expect(isStrkey(DESTINATION, STRKEY_VERSION.seed)).toBe(false);
  });

  it('exports only the four codecs from the subpath', () => {
    expect(Object.keys(codecs).sort()).toEqual([
      'decodeAccountAddress',
      'encodeAccountAddress',
      'isAccountAddress',
      'isContractAddress',
    ]);
  });
});
