// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the attestation message codec (codecs/attestation.ts,
 * exported from the @ujira/chain-adapter/codecs subpath).
 *
 * attestationMessage(fields) lays out the 47 byte message a recipient
 * attester signs: the prefix UJIRA/ATTEST/V2 and the SHA-256 of the field
 * bytes, with the mandate's network ID, the mandate and destination as
 * Address::to_xdr, the two 32 byte references, the epoch and validity as
 * big endian u64, and the tag with a has_tag byte. It agrees byte for byte
 * with the in-memory mandate, which checks attestations the way the
 * contract does. Fields that do not fit, or that name another network,
 * throw InvalidInputError naming the field.
 */

import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import type { NetworkId } from '../networks.js';
import { attestationMessage as engineMessage } from '../testing/attestation.js';
import { hexOf } from '../testing/bytes.js';
import { TEST_CONTRACT, TEST_DESTINATION } from '../testing/stellar.js';
import type { Bytes32, Destination, MandateRef, UnixSeconds } from '../types.js';
import * as codecs from './index.js';

const { ATTESTATION_MESSAGE_BYTES, attestationMessage, networkIdOf } = codecs;

const REF = `0x${'11'.repeat(32)}` as Bytes32;
const POLICY = `0x${'22'.repeat(32)}` as Bytes32;

function fields(
  overrides: {
    network?: NetworkId;
    destination?: string;
    tag?: bigint | null;
    policyEpoch?: bigint;
    validUntil?: bigint;
  } = {},
) {
  const network = overrides.network ?? 'stellar:testnet';
  const mandate: MandateRef = {
    network,
    address: { network, value: TEST_CONTRACT },
    specVersion: 1,
  };
  const destination: Destination = {
    address: { network, value: overrides.destination ?? TEST_DESTINATION },
    tag: overrides.tag === undefined ? 7n : overrides.tag,
  };
  return {
    mandate,
    recipientRef: REF,
    countryPolicyHash: POLICY,
    policyEpoch: overrides.policyEpoch ?? 3n,
    validUntil: (overrides.validUntil ?? 1_900_000_000n) as UnixSeconds,
    destination,
  };
}

function issuesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidInputError);
    return (error as InvalidInputError).issues;
  }
  throw new Error('expected a throw');
}

describe('attestation messages', () => {
  it.each([
    ['an account destination with a tag', {}],
    ['no tag', { tag: null }],
    ['a tag of zero, which is not the same as no tag', { tag: 0n }],
    ['a contract destination', { destination: TEST_CONTRACT }],
    ['pubnet', { network: 'stellar:pubnet' as const }],
    ['the largest u64 values', { policyEpoch: 2n ** 64n - 1n, tag: 2n ** 64n - 1n }],
  ])('match the in-memory mandate for %s', (_label, overrides) => {
    const input = fields(overrides);
    const message = attestationMessage(input);
    expect(message).toHaveLength(ATTESTATION_MESSAGE_BYTES);
    expect(hexOf(message)).toBe(
      hexOf(
        engineMessage({
          networkId: networkIdOf(input.mandate.network),
          mandate: input.mandate.address.value,
          recipientRef: input.recipientRef,
          countryPolicyHash: input.countryPolicyHash,
          policyEpoch: input.policyEpoch,
          validUntil: input.validUntil,
          destination: {
            address: input.destination.address.value,
            tag: input.destination.tag,
          },
        }),
      ),
    );
  });

  it('gives different messages for no tag and a tag of zero', () => {
    expect(attestationMessage(fields({ tag: null }))).not.toEqual(
      attestationMessage(fields({ tag: 0n })),
    );
  });

  it('refuses fields that do not fit or name another network', () => {
    const base = fields();
    expect(issuesOf(() => attestationMessage({ ...base, policyEpoch: -1n }))).toEqual([
      'policyEpoch (out_of_range)',
    ]);
    expect(
      issuesOf(() => attestationMessage({ ...base, validUntil: (2n ** 64n) as UnixSeconds })),
    ).toEqual(['validUntil (out_of_range)']);
    expect(issuesOf(() => attestationMessage(fields({ tag: 2n ** 64n })))).toEqual([
      'destination.tag (out_of_range)',
    ]);
    expect(
      issuesOf(() => attestationMessage({ ...base, recipientRef: '0x12' as Bytes32 })),
    ).toEqual(['recipientRef (invalid)']);
    expect(
      issuesOf(() =>
        attestationMessage({ ...base, countryPolicyHash: `0x${'AB'.repeat(32)}` as Bytes32 }),
      ),
    ).toEqual(['countryPolicyHash (invalid)']);
    expect(
      issuesOf(() =>
        attestationMessage({
          ...base,
          destination: {
            ...base.destination,
            address: { network: 'stellar:pubnet', value: TEST_DESTINATION },
          },
        }),
      ),
    ).toEqual(['destination.address (network_mismatch)']);
    expect(
      issuesOf(() =>
        attestationMessage({
          ...base,
          mandate: {
            ...base.mandate,
            address: { network: 'stellar:pubnet', value: TEST_CONTRACT },
          },
        }),
      ),
    ).toEqual(['mandate.address (network_mismatch)']);
    expect(issuesOf(() => attestationMessage(fields({ destination: 'not an address' })))).toEqual([
      'destination.address (invalid)',
    ]);
    expect(
      issuesOf(() =>
        attestationMessage({ ...base, mandate: { ...base.mandate, network: 'x:y' as NetworkId } }),
      ),
    ).toEqual(['network (invalid)']);
    expect(issuesOf(() => attestationMessage({ ...base, policyEpoch: 1 as never }))).toEqual([
      'policyEpoch (out_of_range)',
    ]);
  });
});
