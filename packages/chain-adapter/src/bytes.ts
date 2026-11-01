// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Byte helpers for the encodings the adapter builds itself. SHA-256 comes
// from node:crypto, so hashing adds no dependency.

import { createHash } from 'node:crypto';

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return Uint8Array.from(hash.digest());
}

export function utf8(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text, 'utf8'));
}

export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

export function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value);
  return out;
}
