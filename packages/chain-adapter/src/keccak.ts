// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Keccak-256 with the original padding Ethereum uses. Node's sha3-256 pads
// differently and gives other digests, and no chain SDK is a dependency
// yet, so config validation carries its own copy to check EIP-55
// checksums. It runs only when a config document is parsed, so it favours
// a short, readable implementation over speed.

const MASK = (1n << 64n) - 1n;
const RATE_BYTES = 136;

const ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

// Rotation offsets, indexed [x][y].
const ROTATIONS = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n],
];

function rotate(value: bigint, by: bigint): bigint {
  return by === 0n ? value : ((value << by) | (value >> (64n - by))) & MASK;
}

function lane(state: readonly bigint[], x: number, y: number): bigint {
  return state[(x % 5) + 5 * (y % 5)] ?? 0n;
}

function permute(state: bigint[]): void {
  for (const constant of ROUND_CONSTANTS) {
    const columns = [0, 1, 2, 3, 4].map(
      (x) =>
        lane(state, x, 0) ^
        lane(state, x, 1) ^
        lane(state, x, 2) ^
        lane(state, x, 3) ^
        lane(state, x, 4),
    );
    const mixed = [0, 1, 2, 3, 4].map(
      (x) => (columns[(x + 4) % 5] ?? 0n) ^ rotate(columns[(x + 1) % 5] ?? 0n, 1n),
    );
    const moved = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const value = lane(state, x, y) ^ (mixed[x] ?? 0n);
        moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(value, ROTATIONS[x]?.[y] ?? 0n);
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] =
          lane(moved, x, y) ^ (~lane(moved, x + 1, y) & MASK & lane(moved, x + 2, y));
      }
    }
    state[0] = (state[0] ?? 0n) ^ constant;
  }
}

/** The 32 byte Keccak-256 digest of `input`. */
export function keccak256(input: Uint8Array): Uint8Array {
  // Pad with 0x01, zeros, and 0x80 on the last byte of the final block.
  const blocks = Math.floor(input.length / RATE_BYTES) + 1;
  const padded = new Uint8Array(blocks * RATE_BYTES);
  padded.set(input);
  padded[input.length] = 0x01;
  const last = padded.length - 1;
  padded[last] = (padded[last] ?? 0) | 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let i = 0; i < RATE_BYTES / 8; i += 1) {
      let word = 0n;
      for (let b = 7; b >= 0; b -= 1) {
        word = (word << 8n) | BigInt(padded[offset + i * 8 + b] ?? 0);
      }
      state[i] = (state[i] ?? 0n) ^ word;
    }
    permute(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    const word = state[Math.floor(i / 8)] ?? 0n;
    out[i] = Number((word >> BigInt((i % 8) * 8)) & 0xffn);
  }
  return out;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Whether `text` is an address whose letter case matches its EIP-55
 * checksum. All lowercase or all uppercase carries no checksum and is
 * refused, because the point is to catch a mistyped address.
 */
export function isEip55Address(text: string): boolean {
  if (!ADDRESS.test(text)) return false;
  const hex = text.slice(2);
  const lower = hex.toLowerCase();
  const digest = keccak256(new TextEncoder().encode(lower));
  for (let i = 0; i < 40; i += 1) {
    const char = hex.charAt(i);
    if (char >= '0' && char <= '9') continue;
    const byte = digest[Math.floor(i / 2)] ?? 0;
    const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    const upper = char !== lower.charAt(i);
    if (upper !== nibble >= 8) return false;
  }
  return true;
}
