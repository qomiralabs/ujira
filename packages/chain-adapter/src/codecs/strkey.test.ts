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
 *
 * Inside the adapter, readStrkey(text, version, payloadBytes) returns the
 * payload, 'checksum' when the shape is right and the CRC16 is not, or
 * 'malformed' for any other fault: wrong length or alphabet, a wrong version
 * byte under a valid checksum, or nonzero padding bits. An M address is the
 * account key then the id as a big endian u64; encodeMuxedAddress(key, id)
 * writes one and splitMuxed reads its payload back.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import * as codecs from './index.js';
import {
  KEY_BYTES,
  MUXED_BYTES,
  STRKEY_VERSION,
  encodeMuxedAddress,
  encodeStrkey,
  isStrkey,
  readStrkey,
  splitMuxed,
} from './strkey.js';

const { decodeAccountAddress, encodeAccountAddress, isAccountAddress, isContractAddress } = codecs;

// The destination and the mandate of the worked attestation example in the
// contract spec, with the key and contract ID bytes it lists.
const DESTINATION = 'GDTYAUMMX45E2SU2Q7JRJHCXDIYTEUAXVBHZ7DVCVXZGMAKMWFL7SOY4';
const DESTINATION_ED25519 = 'e780518cbf3a4d4a9a87d3149c571a31325017a84f9f8ea2adf266014cb157f9';
const MANDATE = 'CDUKSTCG3XKTPTHMNRJZIW23J3T5DKHASDPQ3CIRKQ4YJH3PDOFFULZA';
// Circle's testnet USDC issuer.
const CIRCLE_TESTNET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// The SEP-23 muxed account vectors: the address, the account key and the id.
const ED25519_A = '3f0c34bf93ad0d9971d04ccc90f705511c838aad9734a4a2fb0d7a03fc7fe89a';
const ED25519_B = '363eaa3867841fbad0f4ed88c779e4fe66e56a2470dc98c0ec9c073d05c7b103';
const MUXED_VECTORS: [string, string, bigint][] = [
  ['MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ', ED25519_A, 0n],
  [
    'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK',
    ED25519_A,
    9223372036854775808n,
  ],
  ['MA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAAAAAAAAAPCICBKU', ED25519_B, 123456n],
];

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

  it('reads and writes M addresses as the SEP-23 vectors give them', () => {
    for (const [address, hex, id] of MUXED_VECTORS) {
      const payload = readStrkey(address, STRKEY_VERSION.muxed, MUXED_BYTES);
      if (typeof payload === 'string') throw new Error(`${address} read as ${payload}`);
      const muxed = splitMuxed(payload);
      expect(Buffer.from(muxed.publicKey).toString('hex')).toBe(hex);
      expect(muxed.id).toBe(id);
      expect(encodeMuxedAddress(Buffer.from(hex, 'hex'), id)).toBe(address);
    }
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: KEY_BYTES, maxLength: KEY_BYTES }),
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        (key, id) => {
          const address = encodeMuxedAddress(key, id);
          expect(address).toMatch(/^M[A-Z2-7]{68}$/);
          const payload = readStrkey(address, STRKEY_VERSION.muxed, MUXED_BYTES);
          expect(payload).toBeInstanceOf(Uint8Array);
          expect(splitMuxed(payload as Uint8Array)).toEqual({ publicKey: key, id });
        },
      ),
    );
  });

  it('tells a checksum fault from any other', () => {
    const muxed = (text: string) => readStrkey(text, STRKEY_VERSION.muxed, MUXED_BYTES);
    const account = (text: string) => readStrkey(text, STRKEY_VERSION.account, KEY_BYTES);
    // The other SEP-23 vectors: a bad checksum, a padding bit set, padding
    // characters, wrong lengths, and a valid checksum over a wrong version.
    expect(muxed('MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUO')).toBe(
      'checksum',
    );
    for (const text of [
      'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUR',
      'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUK===',
      'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLKA',
      'MA7QYNF7SOWQ3GLR2DMLK',
    ]) {
      expect(muxed(text)).toBe('malformed');
    }
    for (const text of [
      'G47QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVP2I',
      'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJV75ERQ',
      'GAAAAAAAACGC6',
      'G=3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQHES5',
      7 as unknown as string,
    ]) {
      expect(account(text)).toBe('malformed');
    }
    expect(account(`${DESTINATION.slice(0, -1)}A`)).toBe('checksum');
    expect(account(MANDATE)).toBe('malformed');
  });

  it('refuses a muxed id outside the u64 range, or a key that is not 32 bytes', () => {
    const key = new Uint8Array(KEY_BYTES);
    for (const id of [-1n, 1n << 64n, 7]) {
      const err = thrown(() => encodeMuxedAddress(key, id as bigint));
      expect(err).toBeInstanceOf(InvalidInputError);
      expect((err as InvalidInputError).issues).toEqual(['id (out_of_range)']);
    }
    const err = thrown(() => encodeMuxedAddress(new Uint8Array(31), 0n));
    expect((err as InvalidInputError).issues).toEqual(['publicKey (invalid_length)']);
  });

  // The subpath is everything the signer can reach, so a new export is a
  // deliberate change to this list.
  it('exports only the listed codecs from the subpath', () => {
    expect(Object.keys(codecs).sort()).toEqual([
      'ATTESTATION_MESSAGE_BYTES',
      'CONTRACT_OPERATION_TYPES',
      'MAX_ENVELOPE_SIGNATURES',
      'ZERO_ACCOUNT_ADDRESS',
      'ZERO_CONTRACT_ADDRESS',
      'assertNoMemoOnContractCall',
      'attachAuthEntrySignature',
      'attachEnvelopeSignature',
      'attestationMessage',
      'baseAddress',
      'decodeAccountAddress',
      'decodeAuthEntry',
      'decodeFeeBumpEnvelope',
      'decodeTransactionEnvelope',
      'encodeAccountAddress',
      'encodeMuxedAddress',
      'invocationAuthEntries',
      'isAccountAddress',
      'isContractAddress',
      'isZeroAddress',
      'networkIdOf',
      'networkPassphrase',
    ]);
  });
});
