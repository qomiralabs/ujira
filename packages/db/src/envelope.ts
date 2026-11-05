// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// AES-256-GCM under a subject's data key. The associated data names the tenant and
// the subject, so ciphertext copied onto another recipient will not open.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const DATA_KEY_BYTES = 32;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EnvelopeBinding {
  readonly principalId: string;
  readonly projectId: string;
  readonly subjectId: string;
}

export interface SealedValue {
  // The encrypted bytes with the authentication tag on the end.
  readonly ciphertext: Buffer;
  // 12 bytes.
  readonly nonce: Buffer;
}

// Wrong key, wrong subject or damaged bytes, and it says nothing about which: the
// difference is of use only to someone probing.
export class EnvelopeOpenError extends Error {
  override readonly name = 'EnvelopeOpenError';

  constructor() {
    super('this value could not be opened');
  }
}

function associatedData(binding: EnvelopeBinding): Buffer {
  return Buffer.from(
    `ujira/pii/v1|${binding.principalId}|${binding.projectId}|${binding.subjectId}`,
    'utf8',
  );
}

export function newDataKey(): Buffer {
  return randomBytes(DATA_KEY_BYTES);
}

export function seal(
  dataKey: Uint8Array,
  plaintext: Uint8Array,
  binding: EnvelopeBinding,
): SealedValue {
  // Random, under a key that seals few values for one subject, so a repeat is not
  // a practical risk.
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
  cipher.setAAD(associatedData(binding));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

export function open(dataKey: Uint8Array, sealed: SealedValue, binding: EnvelopeBinding): Buffer {
  if (sealed.ciphertext.length < TAG_BYTES) throw new EnvelopeOpenError();
  const tagAt = sealed.ciphertext.length - TAG_BYTES;
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, sealed.nonce);
    decipher.setAAD(associatedData(binding));
    decipher.setAuthTag(sealed.ciphertext.subarray(tagAt));
    return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, tagAt)), decipher.final()]);
  } catch {
    // Node's message names the failure, which is exactly what must not travel.
    throw new EnvelopeOpenError();
  }
}
