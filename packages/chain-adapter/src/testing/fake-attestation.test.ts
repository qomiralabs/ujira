// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { attestationMessage } from '../codecs/attestation.js';
import { InvalidInputError } from '../errors.js';
import type { AttestationFields } from '../signer.js';
import type { Bytes32, UnixSeconds } from '../types.js';
import { createFakeWorld } from './fake-world.js';

const MANDATE = 'CDUKSTCG3XKTPTHMNRJZIW23J3T5DKHASDPQ3CIRKQ4YJH3PDOFFULZA';
const DESTINATION = 'GDTYAUMMX45E2SU2Q7JRJHCXDIYTEUAXVBHZ7DVCVXZGMAKMWFL7SOY4';

describe('the fake adapter attestation message', () => {
  it('is the codec message, byte for byte, and refuses what the codec refuses', () => {
    const { adapter } = createFakeWorld();
    const fields: AttestationFields = {
      mandate: {
        network: adapter.network,
        address: { network: adapter.network, value: MANDATE },
        specVersion: 1,
      },
      recipientRef: `0x${'18'.repeat(32)}` as Bytes32,
      countryPolicyHash: `0x${'34'.repeat(32)}` as Bytes32,
      policyEpoch: 0n,
      validUntil: 1_767_229_200n as UnixSeconds,
      destination: { address: { network: adapter.network, value: DESTINATION }, tag: null },
    };
    const message = adapter.attestationMessage(fields);
    expect(message).toHaveLength(47);
    expect(message).toEqual(attestationMessage(fields));
    expect(() =>
      adapter.attestationMessage({ ...fields, recipientRef: '0x12' as Bytes32 }),
    ).toThrow(InvalidInputError);
  });
});
