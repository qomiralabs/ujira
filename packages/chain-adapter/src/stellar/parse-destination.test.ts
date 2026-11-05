// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for reading a Stellar destination (stellar/parse-destination.ts),
 * which the Stellar adapter and the fake serve as parseDestination.
 *
 * parseStellarDestination(network, { address, memoId? }) returns the pair
 * the mandate binds, { address: { network, value }, tag }:
 * - a G address gives itself with tag null, or with a memo id that id as a
 *   bigint;
 * - an M address gives its base G and its muxed id, the same pair as that G
 *   with that id as a memo;
 * - a C address gives itself with tag null.
 * A memo id is a u64 in decimal, with no sign, space or leading zero.
 * Anything else throws InvalidInputError carrying the network, a
 * DestinationParseReason and one issue "path (reason)" that names the field,
 * never the value:
 *   MALFORMED          not a plain object, an address that is not a G, C or
 *                      M strkey of the right length and alphabet, a wrong
 *                      version byte, nonzero padding bits, or a memo id that
 *                      is not a string
 *   CHECKSUM           the right shape with a CRC16 that does not match
 *   ZERO_ADDRESS       the all zero key or contract ID
 *   MEMO_NOT_ID        a memo that is not a decimal id: text or a hash
 *   TAG_NOT_SUPPORTED  any memo id with a C or an M address
 *   TAG_OUT_OF_RANGE   a memo id above the largest u64
 * Stellar addresses name no network, so WRONG_NETWORK never comes from here.
 */

import { inspect } from 'node:util';

import fc from 'fast-check';
import { expect, it } from 'vitest';

import {
  KEY_BYTES,
  STRKEY_VERSION,
  decodeAccountAddress,
  encodeAccountAddress,
  encodeMuxedAddress,
  encodeStrkey,
} from '../codecs/strkey.js';
import { DESTINATION_PARSE_REASONS, InvalidInputError } from '../index.js';
import type { Destination, DestinationParseReason, RawDestination } from '../index.js';
import type { StellarNetworkId } from '../networks.js';
import { parseStellarDestination } from './parse-destination.js';

const TESTNET: StellarNetworkId = 'stellar:testnet';
const PUBNET: StellarNetworkId = 'stellar:pubnet';
const U64_MAX = (1n << 64n) - 1n;

// The SEP-23 strkey vectors: two accounts, and M addresses over them with
// ids 0, 123456 and 2^63, which a signed 64 bit id would get wrong.
const ED25519_A = '3f0c34bf93ad0d9971d04ccc90f705511c838aad9734a4a2fb0d7a03fc7fe89a';
const ACCOUNT_A = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const MUXED_A_0 = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ';
const MUXED_A_2_63 = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK';
const ACCOUNT_B = 'GA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQHES5';
const MUXED_B_123456 = 'MA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAAAAAAAAAPCICBKU';
// The mandate of the worked attestation example in the contract spec.
const CONTRACT = 'CDUKSTCG3XKTPTHMNRJZIW23J3T5DKHASDPQ3CIRKQ4YJH3PDOFFULZA';
// Well known as the address nobody holds.
const ZERO_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
// Built at run time, so no seed shaped literal sits in the source.
const SEED = encodeStrkey(STRKEY_VERSION.seed, new Uint8Array(KEY_BYTES).fill(7));

const ADDRESS = 'destination.address';
const MEMO = 'destination.memoId';

// One character changed where only the checksum can notice.
function lastFlipped(address: string): string {
  return `${address.slice(0, -1)}${address.endsWith('A') ? 'B' : 'A'}`;
}

function parse(raw: unknown, network: StellarNetworkId = TESTNET): Destination {
  return parseStellarDestination(network, raw as RawDestination);
}

function refusal(raw: unknown): InvalidInputError {
  let caught: unknown;
  try {
    parse(raw);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(InvalidInputError);
  return caught as InvalidInputError;
}

class Wrapped {
  readonly address = ACCOUNT_A;
}

// Reason, label, input and the field the issue names.
const REFUSED: [DestinationParseReason, string, unknown, string][] = [
  ['MALFORMED', 'input that is not an object', ACCOUNT_A, 'destination'],
  ['MALFORMED', 'null', null, 'destination'],
  ['MALFORMED', 'an array', [ACCOUNT_A], 'destination'],
  ['MALFORMED', 'a class instance', new Wrapped(), 'destination'],
  ['MALFORMED', 'an address that is not a string', { address: 7 }, ADDRESS],
  ['MALFORMED', 'a missing address', {}, ADDRESS],
  [
    'MALFORMED',
    'an address behind a getter',
    {
      get address() {
        return ACCOUNT_A;
      },
    },
    ADDRESS,
  ],
  [
    'MALFORMED',
    'an address on the prototype',
    Object.create({ address: ACCOUNT_A }) as object,
    'destination',
  ],
  ['MALFORMED', 'an empty address', { address: '' }, ADDRESS],
  ['MALFORMED', 'lower case', { address: ACCOUNT_A.toLowerCase() }, ADDRESS],
  ['MALFORMED', 'surrounding space', { address: ` ${ACCOUNT_A}` }, ADDRESS],
  ['MALFORMED', 'a character too few', { address: ACCOUNT_A.slice(0, -1) }, ADDRESS],
  ['MALFORMED', 'a character too many', { address: `${ACCOUNT_A}A` }, ADDRESS],
  ['MALFORMED', 'a G at the length of an M', { address: `G${MUXED_A_0.slice(1)}` }, ADDRESS],
  [
    'MALFORMED',
    'padding characters',
    { address: 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUK===' },
    ADDRESS,
  ],
  [
    'MALFORMED',
    'an M with its padding bit set',
    { address: 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUR' },
    ADDRESS,
  ],
  [
    'MALFORMED',
    'a valid checksum over a wrong version byte',
    { address: 'G47QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVP2I' },
    ADDRESS,
  ],
  ['MALFORMED', 'a seed pasted in by mistake', { address: SEED }, ADDRESS],
  ['MALFORMED', 'a memo id that is not a string', { address: ACCOUNT_A, memoId: 42 }, MEMO],
  ['CHECKSUM', 'a G with a typo', { address: lastFlipped(ACCOUNT_A) }, ADDRESS],
  ['CHECKSUM', 'a C with a typo', { address: lastFlipped(CONTRACT) }, ADDRESS],
  [
    'CHECKSUM',
    'an M with a typo',
    { address: 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUO' },
    ADDRESS,
  ],
  [
    'CHECKSUM',
    'a typo that changes the version byte',
    { address: `G4${ACCOUNT_A.slice(2)}` },
    ADDRESS,
  ],
  ['ZERO_ADDRESS', 'the zero account', { address: ZERO_ACCOUNT }, ADDRESS],
  [
    'ZERO_ADDRESS',
    'the zero contract',
    { address: encodeStrkey(STRKEY_VERSION.contract, new Uint8Array(KEY_BYTES)) },
    ADDRESS,
  ],
  [
    'ZERO_ADDRESS',
    'an M over the zero account',
    { address: encodeMuxedAddress(new Uint8Array(KEY_BYTES), 7n) },
    ADDRESS,
  ],
  ['MEMO_NOT_ID', 'a text memo', { address: ACCOUNT_A, memoId: 'invoice 17' }, MEMO],
  ['MEMO_NOT_ID', 'a hash memo', { address: ACCOUNT_A, memoId: ED25519_A }, MEMO],
  ['TAG_NOT_SUPPORTED', 'a memo id on a C', { address: CONTRACT, memoId: '1' }, MEMO],
  [
    'TAG_NOT_SUPPORTED',
    'a memo id on an M, even its own',
    { address: MUXED_B_123456, memoId: '123456' },
    MEMO,
  ],
  [
    'TAG_OUT_OF_RANGE',
    'a memo id one above the largest u64',
    { address: ACCOUNT_A, memoId: String(U64_MAX + 1n) },
    MEMO,
  ],
  [
    'TAG_OUT_OF_RANGE',
    'a memo id far past it',
    { address: ACCOUNT_A, memoId: `1${'0'.repeat(40)}` },
    MEMO,
  ],
];

it.each(REFUSED)('%s for %s', (reason, _label, raw, path) => {
  const err = refusal(raw);
  expect(err.reason).toBe(reason);
  expect(err.issues).toEqual([`${path} (${reason.toLowerCase()})`]);
  expect(err.network).toBe(TESTNET);
  expect(err.retryable).toBe(false);
  expect(err.toJSON()).toMatchObject({ code: 'INVALID_INPUT', reason, network: TESTNET });
});

// WRONG_NETWORK is what a Stellar address cannot carry, and UNPAYABLE_ADDRESS takes knowing
// what the network settles through, which the text alone cannot show.
it('reaches every reason a Stellar address can show by itself', () => {
  const reached = new Set(REFUSED.map(([reason]) => reason));
  expect([...reached, 'WRONG_NETWORK', 'UNPAYABLE_ADDRESS'].sort()).toEqual(
    [...DESTINATION_PARSE_REASONS].sort(),
  );
  // The same address is valid on every Stellar network.
  for (const network of [PUBNET, TESTNET]) {
    expect(parse({ address: ACCOUNT_A }, network)).toEqual({
      address: { network, value: ACCOUNT_A },
      tag: null,
    });
  }
});

it('G plus memo id and the M address give the same pair', () => {
  const pair = { address: { network: TESTNET, value: ACCOUNT_B }, tag: 123456n };
  expect(parse({ address: ACCOUNT_B, memoId: '123456' })).toEqual(pair);
  expect(parse({ address: MUXED_B_123456 })).toEqual(pair);
  expect(parse({ address: ACCOUNT_A, memoId: '0' })).toEqual(parse({ address: MUXED_A_0 }));
  fc.assert(
    fc.property(
      fc
        .uint8Array({ minLength: KEY_BYTES, maxLength: KEY_BYTES })
        .filter((key) => key.some((byte) => byte !== 0)),
      fc.bigInt({ min: 0n, max: U64_MAX }),
      (key, id) => {
        const account = encodeAccountAddress(key);
        const fromMuxed = parse({ address: encodeMuxedAddress(key, id) });
        expect(fromMuxed).toEqual({ address: { network: TESTNET, value: account }, tag: id });
        expect(parse({ address: account, memoId: String(id) })).toEqual(fromMuxed);
      },
    ),
  );
});

it('text memo gives MEMO_NOT_ID', () => {
  // Text that only looks numeric is text too: a leading zero, a sign, a
  // space or an exponent would not survive the trip to an id.
  for (const memoId of ['invoice 17', 'abc', '', '0042', '+42', '-1', ' 42', '42 ', '4.2', '1e3']) {
    const err = refusal({ address: ACCOUNT_A, memoId });
    expect(err.reason).toBe('MEMO_NOT_ID');
    expect(err.issues).toEqual(['destination.memoId (memo_not_id)']);
  }
});

it('an M address resolves to the G and the muxed id that checkDestination reads', () => {
  const destination = parse({ address: MUXED_A_2_63 });
  expect(destination).toEqual({
    address: { network: TESTNET, value: ACCOUNT_A },
    tag: 9223372036854775808n,
  });
  // The base account is the key the M address carries.
  expect(Buffer.from(decodeAccountAddress(destination.address.value)).toString('hex')).toBe(
    ED25519_A,
  );
  // An id of zero is still a tag, and not the same destination as none.
  expect(parse({ address: MUXED_A_0 }).tag).toBe(0n);
  expect(parse({ address: ACCOUNT_A }).tag).toBeNull();
});

it('reads a C address and a plain G with no tag, and the largest memo id', () => {
  expect(parse({ address: CONTRACT })).toEqual({
    address: { network: TESTNET, value: CONTRACT },
    tag: null,
  });
  expect(parse({ address: ACCOUNT_A, memoId: undefined })).toEqual({
    address: { network: TESTNET, value: ACCOUNT_A },
    tag: null,
  });
  expect(parse({ address: ACCOUNT_A, memoId: String(U64_MAX) }).tag).toBe(U64_MAX);
  expect(parse(Object.assign(Object.create(null) as object, { address: CONTRACT })).tag).toBeNull();
});

it('names the field in the error, never the value', () => {
  const memo = 'customer 4471 at the exchange';
  for (const raw of [
    { address: SEED },
    { address: lastFlipped(ACCOUNT_B) },
    { address: ACCOUNT_B, memoId: memo },
  ]) {
    const err = refusal(raw);
    const printed = [
      inspect(err, { depth: Infinity, showHidden: true }),
      JSON.stringify(err.toJSON()),
      String(err.stack),
    ].join('\n');
    for (const value of [SEED, ACCOUNT_B, lastFlipped(ACCOUNT_B), memo]) {
      expect(printed).not.toContain(value);
    }
  }
});
