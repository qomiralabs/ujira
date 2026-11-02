// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The fake adapter's attestation message (fake-adapter.ts). Services test
 * against the fake, so it must build exactly the bytes the Stellar adapter
 * builds and the mandate verifies, and refuse the same inputs.
 */

import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import type { AttestationFields } from '../signer.js';
import { stellarAttestationMessage } from '../stellar/attestation-message.js';
import type { Bytes32, UnixSeconds } from '../types.js';
import { fakeAdapterHarness } from './fake-world.js';
import { TEST_CONTRACT, TEST_DESTINATION } from './stellar.js';

function fields(tag: bigint | null, policyEpoch = 3n): AttestationFields {
  const network = fakeAdapterHarness().adapter.network;
  return {
    mandate: { network, address: { network, value: TEST_CONTRACT }, specVersion: 1 },
    recipientRef: `0x${'11'.repeat(32)}` as Bytes32,
    countryPolicyHash: `0x${'22'.repeat(32)}` as Bytes32,
    policyEpoch,
    validUntil: 1_900_000_000n as UnixSeconds,
    destination: { address: { network, value: TEST_DESTINATION }, tag },
  };
}

describe('fake attestation message', () => {
  it.each([
    ['a tag', 7n],
    ['no tag', null],
  ])('the fake builds the same attestation message as the Stellar adapter, with %s', (_l, tag) => {
    const { adapter } = fakeAdapterHarness();
    const input = fields(tag);
    expect(adapter.attestationMessage(input)).toEqual(stellarAttestationMessage(input));
  });

  it('refuses what the Stellar adapter refuses', () => {
    const { adapter } = fakeAdapterHarness();
    expect(() => adapter.attestationMessage(fields(7n, -1n))).toThrow(InvalidInputError);
  });
});
