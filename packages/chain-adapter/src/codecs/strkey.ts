// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Stellar strkeys: a version byte, a 32 byte payload and a CRC16 checksum,
// in base32. Written out here rather than taken from a Stellar library, so
// configuration and the signer can read and write addresses with no chain
// dependency at all.

import { InvalidInputError } from '../errors.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Version bytes of the strkey kinds UJIRA reads. */
export const STRKEY_VERSION = Object.freeze({
  account: 6 << 3,
  contract: 2 << 3,
  seed: 18 << 3,
});

const PAYLOAD_BYTES = 32;
// The version byte and the payload, which the checksum covers.
const BODY_BYTES = 1 + PAYLOAD_BYTES;
const RAW_BYTES = BODY_BYTES + 2;

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function readBase32(text: string): Uint8Array | undefined {
  if (!/^[A-Z2-7]{56}$/.test(text)) return undefined;
  const bytes = new Uint8Array(RAW_BYTES);
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const char of text) {
    // Only the low bits not yet emitted matter, so the buffer stays small.
    buffer = ((buffer << 5) | BASE32.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[at] = (buffer >> bits) & 0xff;
      at += 1;
    }
  }
  // 56 characters carry 280 bits, exactly 35 bytes, so nothing is left over.
  return bytes;
}

// The payload of a strkey of this version, or undefined unless the version
// byte and the checksum both hold. A typo in an address would otherwise
// surface only at the first RPC call, or worse, name a different account
// that happens to exist.
function readStrkey(text: string, version: number): Uint8Array | undefined {
  const bytes = typeof text === 'string' ? readBase32(text) : undefined;
  if (bytes === undefined) return undefined;
  const crc = crc16Xmodem(bytes.subarray(0, BODY_BYTES));
  const valid =
    bytes[0] === version &&
    bytes[BODY_BYTES] === (crc & 0xff) &&
    bytes[BODY_BYTES + 1] === crc >> 8;
  return valid ? bytes.slice(1, BODY_BYTES) : undefined;
}

/** Whether `text` is a strkey of this version with a valid checksum. */
export function isStrkey(text: string, version: number): boolean {
  return readStrkey(text, version) !== undefined;
}

/** Whether `text` is a G account address. */
export function isAccountAddress(text: string): boolean {
  return isStrkey(text, STRKEY_VERSION.account);
}

/** Whether `text` is a C contract address. */
export function isContractAddress(text: string): boolean {
  return isStrkey(text, STRKEY_VERSION.contract);
}

/** The 32 byte ed25519 public key a G address carries. */
export function decodeAccountAddress(address: string): Uint8Array {
  const key = readStrkey(address, STRKEY_VERSION.account);
  if (key === undefined) throw new InvalidInputError({ issues: ['address (invalid)'] });
  return key;
}

/** The G address of a 32 byte ed25519 public key. */
export function encodeAccountAddress(publicKey: Uint8Array): string {
  return encodeStrkey(STRKEY_VERSION.account, publicKey);
}

/** A strkey of any version over a 32 byte payload. */
export function encodeStrkey(version: number, payload: Uint8Array): string {
  if (!(payload instanceof Uint8Array) || payload.length !== PAYLOAD_BYTES) {
    throw new InvalidInputError({ issues: ['publicKey (invalid_length)'] });
  }
  const bytes = new Uint8Array(RAW_BYTES);
  bytes[0] = version;
  bytes.set(payload, 1);
  const crc = crc16Xmodem(bytes.subarray(0, BODY_BYTES));
  bytes[BODY_BYTES] = crc & 0xff;
  bytes[BODY_BYTES + 1] = crc >> 8;
  let text = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    // At most four bits wait from the last byte, so twelve fit easily.
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += BASE32.charAt((buffer >> bits) & 31);
    }
  }
  return text;
}
