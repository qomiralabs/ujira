// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Byte helpers and ed25519 for the fake chain. ed25519 comes from node:crypto
// so the fake needs no new dependency; OpenSSL refuses a signature whose S is
// not below the group order, which is the strictness the spec's tamper kinds
// rely on.

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import { concat, sha256, u32be, u64be, utf8 } from '../bytes.js';
import { InvalidInputError } from '../errors.js';

const BYTES32 = /^0x[0-9a-f]{64}$/;
const HEX = /^0x(?:[0-9a-f]{2})*$/;

// DER wrappers that turn raw ed25519 key bytes into the forms node:crypto
// imports: PKCS#8 for a 32 byte seed and SPKI for a 32 byte public key.
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const SPKI_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** 0x and 64 lower case hex characters: a payout ID, a reference or a hash. */
export function isBytes32(value: unknown): value is string {
  return typeof value === 'string' && BYTES32.test(value);
}

export function hexOf(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

/** The bytes of 0x and an even number of lower case hex digits. */
export function bytesOf(hex: string): Uint8Array {
  if (!HEX.test(hex)) throw new InvalidInputError({ issues: ['hex (invalid)'] });
  return Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
}

// The encoders are the adapter's own; the fake chain builds the same bytes
// with them rather than with a copy.
export { concat, sha256, u32be, u64be, utf8 };

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function privateKey(seed: Uint8Array): ReturnType<typeof createPrivateKey> {
  if (seed.length !== 32) throw new InvalidInputError({ issues: ['seed (invalid_length)'] });
  return createPrivateKey({
    key: Buffer.from(concat(PKCS8_ED25519_PREFIX, seed)),
    format: 'der',
    type: 'pkcs8',
  });
}

/** The ed25519 public key of a 32 byte seed. */
export function ed25519PublicKey(seed: Uint8Array): Uint8Array {
  const der = createPublicKey(privateKey(seed)).export({ format: 'der', type: 'spki' });
  return Uint8Array.from(der.subarray(SPKI_ED25519_PREFIX.length));
}

/** The deterministic ed25519 signature (RFC 8032) of a 32 byte seed over a message. */
export function ed25519Sign(seed: Uint8Array, message: Uint8Array): Uint8Array {
  return Uint8Array.from(sign(null, message, privateKey(seed)));
}

/**
 * Whether the signature verifies. A key that is not 32 bytes or does not
 * decode to a point, and a signature that is not 64 bytes, verify as false,
 * as the host's verification fails on them.
 */
export function ed25519Verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(concat(SPKI_ED25519_PREFIX, publicKey)),
      format: 'der',
      type: 'spki',
    });
    return verify(null, message, key, signature);
  } catch {
    // OpenSSL refuses some 32 byte strings as keys outright; for the host
    // that is a failed verification like any other.
    return false;
  }
}
