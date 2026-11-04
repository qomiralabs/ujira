// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Stellar strkeys: a version byte, a payload and a CRC16 checksum, in
// base32. Written out here rather than taken from a Stellar library, so
// configuration and the signer can read and write addresses with no chain
// dependency at all.

import { InvalidInputError } from '../errors.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Version bytes of the strkey kinds UJIRA reads. */
export const STRKEY_VERSION = Object.freeze({
  account: 6 << 3,
  contract: 2 << 3,
  muxed: 12 << 3,
  seed: 18 << 3,
});

/** The payload of a G, C or S strkey: an ed25519 key or a contract ID. */
export const KEY_BYTES = 32;
/** The payload of an M address: the account key, then the id as a big endian u64. */
export const MUXED_BYTES = KEY_BYTES + 8;
const U64_MAX = (1n << 64n) - 1n;

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

/**
 * Why a text is not a strkey of the kind asked for. A checksum fault is
 * kept apart because it is what a typo looks like: the right shape with one
 * character wrong.
 */
export type StrkeyFault = 'malformed' | 'checksum';

/**
 * The payload of a strkey of this version and payload length, or its fault.
 * The checksum is checked before the version byte, so a typo anywhere, the
 * version included, reads as a checksum fault. A typo in an address would
 * otherwise surface only at the first RPC call, or worse, name a different
 * account that happens to exist.
 */
export function readStrkey(
  text: string,
  version: number,
  payloadBytes: number,
): Uint8Array | StrkeyFault {
  const input: unknown = text;
  const body = 1 + payloadBytes;
  const bytes = new Uint8Array(body + 2);
  // Five bits a character, with the last one padded.
  const length = Math.ceil((bytes.length * 8) / 5);
  if (typeof input !== 'string' || input.length !== length || !/^[A-Z2-7]+$/.test(input)) {
    return 'malformed';
  }
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const char of input) {
    // Only the low bits not yet emitted matter, so the buffer stays small.
    buffer = ((buffer << 5) | BASE32.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[at] = (buffer >> bits) & 0xff;
      at += 1;
    }
  }
  const crc = crc16Xmodem(bytes.subarray(0, body));
  if (bytes[body] !== (crc & 0xff) || bytes[body + 1] !== crc >> 8) return 'checksum';
  // A valid checksum over another version byte is another kind of strkey,
  // and padding bits must be zero, or two texts would read as one address.
  if (bytes[0] !== version || (buffer & ((1 << bits) - 1)) !== 0) return 'malformed';
  return bytes.slice(1, body);
}

function readKey(text: string, version: number): Uint8Array | undefined {
  const payload = readStrkey(text, version, KEY_BYTES);
  return typeof payload === 'string' ? undefined : payload;
}

/** Whether `text` is a strkey of this version with a valid checksum. */
export function isStrkey(text: string, version: number): boolean {
  return readKey(text, version) !== undefined;
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
  const key = readKey(address, STRKEY_VERSION.account);
  if (key === undefined) throw new InvalidInputError({ issues: ['address (invalid)'] });
  return key;
}

/** The G address of a 32 byte ed25519 public key. */
export function encodeAccountAddress(publicKey: Uint8Array): string {
  return encodeStrkey(STRKEY_VERSION.account, publicKey);
}

const ZERO_KEY = new Uint8Array(KEY_BYTES);

/** The account whose ed25519 key is 32 zero bytes; nobody holds its key. */
export const ZERO_ACCOUNT_ADDRESS = encodeStrkey(STRKEY_VERSION.account, ZERO_KEY);
/** The contract whose ID is the same 32 zero bytes; nothing can ever run there. */
export const ZERO_CONTRACT_ADDRESS = encodeStrkey(STRKEY_VERSION.contract, ZERO_KEY);

/** Whether a strkey payload starts with an all-zero key: an M payload carries its id after it. */
export function isZeroKey(payload: Uint8Array): boolean {
  return payload.subarray(0, KEY_BYTES).every((byte) => byte === 0);
}

/**
 * The contract's is_zero_address, in strkeys: whatever is sent to one of these
 * is gone for good. An M address is judged by its base account, since the id
 * only tells that account's owner who a payment is for. Text that is no
 * address is not zero; refusing it is the codecs' job.
 */
export function isZeroAddress(address: string): boolean {
  const base = baseAddress(address);
  return base === ZERO_ACCOUNT_ADDRESS || base === ZERO_CONTRACT_ADDRESS;
}

/**
 * The G account an M address pays, or the text unchanged. The id in an M
 * address only tells that account's owner who a payment is for, so any rule
 * about where money lands has to look through it.
 */
export function baseAddress(address: string): string {
  const muxed = readStrkey(address, STRKEY_VERSION.muxed, MUXED_BYTES);
  return typeof muxed === 'string' ? address : encodeAccountAddress(splitMuxed(muxed).publicKey);
}

/** The account key and the id an M address payload carries. */
export function splitMuxed(payload: Uint8Array): {
  readonly publicKey: Uint8Array;
  readonly id: bigint;
} {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { publicKey: payload.slice(0, KEY_BYTES), id: view.getBigUint64(KEY_BYTES) };
}

/** The M address of an account key and an id. */
export function encodeMuxedAddress(publicKey: Uint8Array, id: bigint): string {
  const input: unknown = id;
  if (typeof input !== 'bigint' || input < 0n || input > U64_MAX) {
    throw new InvalidInputError({ issues: ['id (out_of_range)'] });
  }
  const payload = new Uint8Array(MUXED_BYTES);
  payload.set(checkKey(publicKey));
  new DataView(payload.buffer).setBigUint64(KEY_BYTES, input);
  return writeStrkey(STRKEY_VERSION.muxed, payload);
}

/** A strkey of any version over a 32 byte payload. */
export function encodeStrkey(version: number, payload: Uint8Array): string {
  return writeStrkey(version, checkKey(payload));
}

function checkKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new InvalidInputError({ issues: ['publicKey (invalid_length)'] });
  }
  return key;
}

function writeStrkey(version: number, payload: Uint8Array): string {
  const body = 1 + payload.length;
  const bytes = new Uint8Array(body + 2);
  bytes[0] = version;
  bytes.set(payload, 1);
  const crc = crc16Xmodem(bytes.subarray(0, body));
  bytes[body] = crc & 0xff;
  bytes[body + 1] = crc >> 8;
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
  // An M address ends part way through a character, padded with zero bits.
  if (bits > 0) text += BASE32.charAt((buffer << (5 - bits)) & 31);
  return text;
}
