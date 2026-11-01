// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The recipient attestation message, laid out here so the attester signs
// bytes it built itself from typed fields and never bytes a caller handed
// it. The layout is the mandate's: the prefix and the SHA-256 of the field
// bytes, which no 32 byte transaction hash can ever be mistaken for.

import { createHash } from 'node:crypto';

import type { NetworkId } from '../networks.js';
import type { Bytes32, Destination, MandateRef, UnixSeconds } from '../types.js';

import { checkNetwork, networkIdOf } from './network.js';
import { KEY_BYTES, STRKEY_VERSION, readStrkey } from './strkey.js';
import { invalid } from './xdr.js';

export const ATTESTATION_PREFIX = 'UJIRA/ATTEST/V2';
/** The prefix and a SHA-256. */
export const ATTESTATION_MESSAGE_BYTES = 47;

/** What an attestation binds; the signer port's AttestationFields has this shape. */
export interface AttestationMessageFields {
  readonly mandate: MandateRef;
  readonly recipientRef: Bytes32;
  readonly countryPolicyHash: Bytes32;
  readonly policyEpoch: bigint;
  readonly validUntil: UnixSeconds;
  readonly destination: Destination;
}

const BYTES32 = /^0x[0-9a-f]{64}$/;
const U64_MAX = (1n << 64n) - 1n;
// ScVal and ScAddress discriminants of Address::to_xdr.
const SCV_ADDRESS = 18;
const SC_ADDRESS_ACCOUNT = 0;
const SC_ADDRESS_CONTRACT = 1;
const PUBLIC_KEY_ED25519 = 0;

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function u64(field: string, value: unknown): Buffer {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw invalid(field, 'out_of_range');
  }
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(value);
  return out;
}

function bytes32(field: string, value: unknown): Buffer {
  if (typeof value !== 'string' || !BYTES32.test(value)) throw invalid(field, 'invalid');
  return Buffer.from(value.slice(2), 'hex');
}

// Address::to_xdr, behind a one byte length as the message carries it.
function address(field: string, network: NetworkId, value: { network: unknown; value: unknown }) {
  if (value.network !== network) throw invalid(field, 'network_mismatch');
  const text = typeof value.value === 'string' ? value.value : '';
  const account = readStrkey(text, STRKEY_VERSION.account, KEY_BYTES);
  const contract = readStrkey(text, STRKEY_VERSION.contract, KEY_BYTES);
  let xdr: Buffer;
  if (typeof account !== 'string') {
    xdr = Buffer.concat([
      u32(SCV_ADDRESS),
      u32(SC_ADDRESS_ACCOUNT),
      u32(PUBLIC_KEY_ED25519),
      account,
    ]);
  } else if (typeof contract !== 'string') {
    xdr = Buffer.concat([u32(SCV_ADDRESS), u32(SC_ADDRESS_CONTRACT), contract]);
  } else {
    throw invalid(field, 'invalid');
  }
  return Buffer.concat([Buffer.of(xdr.length), xdr]);
}

/** The 47 byte message the attester signs for one leg. */
export function attestationMessage(fields: AttestationMessageFields): Uint8Array {
  const network = checkNetwork(fields.mandate.network);
  const mandate = address('mandate.address', network, fields.mandate.address);
  const recipientRef = bytes32('recipientRef', fields.recipientRef);
  const countryPolicyHash = bytes32('countryPolicyHash', fields.countryPolicyHash);
  const policyEpoch = u64('policyEpoch', fields.policyEpoch);
  const validUntil = u64('validUntil', fields.validUntil);
  const destination = address('destination.address', network, fields.destination.address);
  const tag = fields.destination.tag;
  // No tag is has_tag 0 with tag 0, so it can never stand for a tag of 0.
  const tagged = Buffer.concat([
    Buffer.of(tag === null ? 0 : 1),
    u64('destination.tag', tag ?? 0n),
  ]);
  const digest = createHash('sha256')
    .update(networkIdOf(network))
    .update(mandate)
    .update(recipientRef)
    .update(countryPolicyHash)
    .update(policyEpoch)
    .update(validUntil)
    .update(destination)
    .update(tagged)
    .digest();
  return Uint8Array.from(Buffer.concat([Buffer.from(ATTESTATION_PREFIX, 'utf8'), digest]));
}
