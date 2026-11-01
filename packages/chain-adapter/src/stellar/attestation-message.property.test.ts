// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { STRKEY_VERSION, encodeStrkey } from '../codecs/strkey.js';
import { NETWORK_IDS } from '../networks.js';
import type { AttestationFields } from '../signer.js';
import type { Bytes32, UnixSeconds } from '../types.js';

import { ATTESTATION_MESSAGE_BYTES, stellarAttestationMessage } from './attestation-message.js';

const U64_MAX = (1n << 64n) - 1n;
const PREFIX = Buffer.from('UJIRA/ATTEST/V2', 'ascii');

const key32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
const hex32 = key32.map((b) => `0x${Buffer.from(b).toString('hex')}` as Bytes32);
const u64 = fc.bigInt({ min: 0n, max: U64_MAX });
const baseAddress = fc.oneof(
  key32.map((b) => encodeStrkey(STRKEY_VERSION.account, b)),
  key32.map((b) => encodeStrkey(STRKEY_VERSION.contract, b)),
);

const fieldsArb: fc.Arbitrary<AttestationFields> = fc
  .record({
    network: fc.constantFrom(...NETWORK_IDS),
    mandate: key32.map((b) => encodeStrkey(STRKEY_VERSION.contract, b)),
    recipientRef: hex32,
    countryPolicyHash: hex32,
    policyEpoch: u64,
    validUntil: u64,
    destination: baseAddress,
    tag: fc.option(u64, { nil: null }),
  })
  .map((r) => ({
    mandate: {
      network: r.network,
      address: { network: r.network, value: r.mandate },
      specVersion: 1,
    },
    recipientRef: r.recipientRef,
    countryPolicyHash: r.countryPolicyHash,
    policyEpoch: r.policyEpoch,
    validUntil: r.validUntil as UnixSeconds,
    destination: { address: { network: r.network, value: r.destination }, tag: r.tag },
  }));

describe('attestation message properties', () => {
  it('output is always 47 bytes starting UJIRA/ATTEST/V2', () => {
    fc.assert(
      fc.property(fieldsArb, (fields) => {
        const message = stellarAttestationMessage(fields);
        expect(message).toHaveLength(ATTESTATION_MESSAGE_BYTES);
        // Never the 32 bytes of a transaction hash, so it can never be one.
        expect(message.length).not.toBe(32);
        expect(Buffer.from(message.subarray(0, PREFIX.length)).equals(PREFIX)).toBe(true);
        // Pure: the same fields give the same bytes.
        expect(Buffer.from(stellarAttestationMessage(fields)).equals(Buffer.from(message))).toBe(
          true,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('binds every field: changing any one changes the message', () => {
    fc.assert(
      fc.property(fieldsArb, u64, (fields, other) => {
        const base = Buffer.from(stellarAttestationMessage(fields));
        const variants: AttestationFields[] = [
          { ...fields, policyEpoch: fields.policyEpoch ^ 1n },
          { ...fields, validUntil: (fields.validUntil ^ 1n) as UnixSeconds },
          {
            ...fields,
            destination: {
              ...fields.destination,
              tag: fields.destination.tag === other ? null : other,
            },
          },
        ];
        for (const variant of variants) {
          expect(Buffer.from(stellarAttestationMessage(variant)).equals(base)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});
