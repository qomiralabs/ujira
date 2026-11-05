// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// SEP-53 signed messages: the wallet signs the SHA-256 of a fixed prefix
// followed by the message, with the account's ed25519 key. The prefix keeps
// a signed message from ever being a valid transaction signature.

import { createHash, createPublicKey, verify } from 'node:crypto';

export const SEP53_PREFIX = 'Stellar Signed Message:\n';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The 32 bytes a SEP-53 signature covers. Text is UTF-8 encoded; bytes are used as they are. */
export function sep53Hash(message: string | Uint8Array): Uint8Array {
  const body = typeof message === 'string' ? Buffer.from(message, 'utf8') : message;
  return Uint8Array.from(
    createHash('sha256').update(Buffer.from(SEP53_PREFIX, 'utf8')).update(body).digest(),
  );
}

/** Whether `signature` is a valid SEP-53 signature of `message` by the ed25519 `publicKey`. */
export function verifySep53(
  publicKey: Uint8Array,
  message: string | Uint8Array,
  signature: Uint8Array,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, sep53Hash(message), key, signature);
}
