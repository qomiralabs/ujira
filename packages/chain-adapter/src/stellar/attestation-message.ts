// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The version 2 recipient attestation message, byte for byte as the Soroban
// mandate rebuilds it before it verifies the attester's ed25519 signature:
//
//   fields  = network_id[32] | u8 len | mandate | recipient_ref[32]
//           | country_policy_hash[32] | u64be policy_epoch | u64be valid_until
//           | u8 len | destination | u8 has_tag | u64be tag
//   message = "UJIRA/ATTEST/V2" | SHA-256(fields)
//
// Addresses are Address::to_xdr of the base address, and a muxed id is the
// tag. Building the message is pure; signing it is the attester signer's job
// and is not done here.

import { concat, sha256, u64be, utf8 } from '../bytes.js';
import { isContractAddress } from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';
import type { AttestationFields } from '../signer.js';

import { addressXdr } from './address-xdr.js';
import { stellarNetworkId } from './network-id.js';

export const ATTESTATION_PREFIX = 'UJIRA/ATTEST/V2';
/** 15 prefix bytes and a 32 byte SHA-256: never the length of a transaction hash. */
export const ATTESTATION_MESSAGE_BYTES = 47;

const U64_MAX = (1n << 64n) - 1n;
const BYTES32 = /^0x[0-9a-f]{64}$/;

/** The signed fields as raw bytes, the layout before hashing. */
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

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 255) throw new InvalidInputError({ issues: ['address (invalid_length)'] });
  return concat(Uint8Array.of(bytes.length), bytes);
}

/** The field bytes, before hashing. */
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

/** The prefix and the SHA-256 of the field bytes. */
export function attestationMessageOf(fields: Uint8Array): Uint8Array {
  return concat(utf8(ATTESTATION_PREFIX), sha256(fields));
}

function bytes32(field: string, value: unknown): Uint8Array {
  if (typeof value !== 'string' || !BYTES32.test(value)) {
    throw new InvalidInputError({ issues: [`${field} (invalid)`] });
  }
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
}

function u64(field: string, value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw new InvalidInputError({ issues: [`${field} (out_of_range)`] });
  }
  return value;
}

/**
 * The 47 byte message an attester signs for one leg, on Stellar. Throws
 * InvalidInputError for a field the mandate could never accept: a mandate
 * that is not a contract, a destination on another network or not a base
 * G or C address, a reference that is not 32 bytes, or a number outside u64.
 */
export function stellarAttestationMessage(fields: AttestationFields): Uint8Array {
  const network = fields.mandate.network;
  const mandate = fields.mandate.address;
  if (mandate.network !== network || !isContractAddress(mandate.value)) {
    throw new InvalidInputError({ issues: ['mandate (invalid)'] });
  }
  if (fields.destination.address.network !== network) {
    throw new InvalidInputError({ issues: ['destination.network (mismatch)'] });
  }
  const tag = fields.destination.tag;
  const bytes: AttestationFieldBytes = {
    networkId: stellarNetworkId(network),
    mandate: addressXdr(mandate.value),
    recipientRef: bytes32('recipientRef', fields.recipientRef),
    countryPolicyHash: bytes32('countryPolicyHash', fields.countryPolicyHash),
    policyEpoch: u64('policyEpoch', fields.policyEpoch),
    validUntil: u64('validUntil', fields.validUntil),
    destination: addressXdr(fields.destination.address.value),
    tag: tag === null ? null : u64('destination.tag', tag),
  };
  return attestationMessageOf(encodeAttestationFields(bytes));
}
