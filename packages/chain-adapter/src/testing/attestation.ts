// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The version 2 recipient attestation on the fake chain: the fields the
// attester signs for one leg, and a test signature over them. The layout and
// the message come from the adapter's own encoder, so the fake mandate, the
// tests and the Stellar adapter build the same bytes as the real contract.
// Signing lives here only; outside tests, attestations are signed by the
// attester signer service.

import {
  ATTESTATION_PREFIX,
  attestationMessageOf,
  encodeAttestationFields,
} from '../stellar/attestation-message.js';
import type { AttestationFieldBytes } from '../stellar/attestation-message.js';

import { addressXdr } from './address.js';
import { bytesOf, ed25519Sign } from './bytes.js';
import type { EngineDestination } from './types.js';

export { ATTESTATION_PREFIX, attestationMessageOf, encodeAttestationFields };
export type { AttestationFieldBytes };

/** What an attestation for one leg binds. */
export interface AttestationSubject {
  readonly networkId: Uint8Array;
  readonly mandate: string;
  readonly recipientRef: string;
  readonly countryPolicyHash: string;
  readonly policyEpoch: bigint;
  readonly validUntil: bigint;
  readonly destination: EngineDestination;
}

export function attestationFieldBytes(subject: AttestationSubject): AttestationFieldBytes {
  return {
    networkId: subject.networkId,
    mandate: addressXdr(subject.mandate),
    recipientRef: bytesOf(subject.recipientRef),
    countryPolicyHash: bytesOf(subject.countryPolicyHash),
    policyEpoch: subject.policyEpoch,
    validUntil: subject.validUntil,
    destination: addressXdr(subject.destination.address),
    tag: subject.destination.tag,
  };
}

export function attestationMessage(subject: AttestationSubject): Uint8Array {
  return attestationMessageOf(encodeAttestationFields(attestationFieldBytes(subject)));
}

/** The attester's signature for one leg, from its 32 byte ed25519 seed. */
export function signAttestation(attesterSeed: Uint8Array, subject: AttestationSubject): Uint8Array {
  return ed25519Sign(attesterSeed, attestationMessage(subject));
}
