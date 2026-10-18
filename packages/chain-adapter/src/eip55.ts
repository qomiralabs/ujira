// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { keccak_256 } from '@noble/hashes/sha3.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Whether `text` is an address whose letter case matches its EIP-55
 * checksum, applied exactly. An all lowercase or all uppercase address is
 * refused unless it happens to be its own checksum, which is rare; the
 * point is to catch a mistyped address.
 */
export function isEip55Address(text: string): boolean {
  if (typeof text !== 'string' || !ADDRESS.test(text)) return false;
  const hex = text.slice(2);
  const lower = hex.toLowerCase();
  // Each letter is uppercase exactly when the matching nibble of the
  // Keccak-256 of the lowercase address is 8 or more.
  const digest = Array.from(keccak_256(new TextEncoder().encode(lower)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  for (let i = 0; i < hex.length; i += 1) {
    const char = hex.charAt(i);
    // Digits have no case to check.
    if (char >= '0' && char <= '9') continue;
    const upper = char !== lower.charAt(i);
    if (upper !== Number.parseInt(digest.charAt(i), 16) >= 8) return false;
  }
  return true;
}
