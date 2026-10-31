// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The version 2 recipient attestation: the fields the attester signs for one
// leg, the 47 byte message and the ed25519 signature over it. The fake
// mandate verifies with these and a test signs with them, so both build the
// same bytes the real contract and the attester service do.

import { InvalidInputError } from '../errors.js';

import { addressXdr } from './address.js';
import { bytesOf, concat, ed25519Sign, sha256, u64be, utf8 } from './bytes.js';
import type { EngineDestination } from './types.js';

export const ATTESTATION_PREFIX = 'UJIRA/ATTEST/V2';

/** The signed fields as raw bytes, so a test can damage any one of them. */
export interface AttestationFieldBytes {
  readonly networkId: Uint8Array;
  /** The mandate's Address::to_xdr bytes. */
  readonly mandate: Uint8Array;
  readonly recipientRef: Uint8Array;
  readonly countryPolicyHash: Uint8Array;
  readonly policyEpoch: bigint;
  readonly validUntil: bigint;
  /** The destination's base address as Address::to_xdr bytes. */
  readonly destination: Uint8Array;
  readonly tag: bigint | null;
}

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

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 255) throw new InvalidInputError({ issues: ['address (invalid_length)'] });
  return concat(Uint8Array.of(bytes.length), bytes);
}

/** The field bytes of spec/ENCODING.md, before hashing. */
export function encodeAttestationFields(f: AttestationFieldBytes): Uint8Array {
  // No tag is has_tag 0 with tag 0, so it can never stand for tag 0.
  const hasTag = f.tag === null ? 0 : 1;
  return concat(
    f.networkId,
    lengthPrefixed(f.mandate),
    f.recipientRef,
    f.countryPolicyHash,
    u64be(f.policyEpoch),
    u64be(f.validUntil),
    lengthPrefixed(f.destination),
    Uint8Array.of(hasTag),
    u64be(f.tag ?? 0n),
  );
}

/**
 * The prefix and the SHA-256 of the fields: the ATTESTATION_MESSAGE_BYTES
 * the attester signs, a length no 32 byte transaction hash can ever have.
 */
export function attestationMessageOf(fields: Uint8Array): Uint8Array {
  return concat(utf8(ATTESTATION_PREFIX), sha256(fields));
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
