// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Shared reading rules for the envelope and authorization entry codecs.
// What reaches them comes from outside UJIRA, so a text is accepted only in
// its one canonical form: base64 that re-encodes to itself, of XDR that
// re-encodes to itself. Two texts for one envelope would let a payload that
// passed a check be swapped for a different looking one that did not.

import type { xdr } from '@stellar/stellar-base';

import { InvalidInputError } from '../errors.js';

import { KEY_BYTES, STRKEY_VERSION, encodeMuxedAddress, encodeStrkey } from './strkey.js';

/**
 * Far above any transaction the network accepts. It only bounds how much
 * work one call can be made to do before anything is decoded.
 */
export const MAX_XDR_BASE64 = 349_528;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** An ed25519 signature and the key that made it, as the signer port returns them. */
export interface Ed25519SignatureParts {
  readonly publicKey: Uint8Array;
  readonly signature: Uint8Array;
}

/** An account as an envelope names it. */
export interface DecodedAccount {
  /** As written: a G address, or an M address for a muxed account. */
  readonly address: string;
  /** The G account whose key signs for it; the same as address unless muxed. */
  readonly account: string;
}

export function invalid(field: string, code: string): InvalidInputError {
  return new InvalidInputError({ issues: [`${field} (${code})`] });
}

interface Canonical {
  toXDR(format: 'base64'): string;
}

/** Reads `text` with `read`, refusing anything but the canonical encoding. */
export function readXdr<T extends Canonical>(
  text: unknown,
  field: string,
  read: (text: string) => T,
): T {
  if (typeof text !== 'string' || text.length === 0) throw invalid(field, 'malformed');
  if (text.length > MAX_XDR_BASE64) throw invalid(field, 'too_long');
  if (!BASE64.test(text)) throw invalid(field, 'malformed');
  let value: T;
  try {
    value = read(text);
  } catch {
    // The library's message can quote the input, so only the fact is kept.
    throw invalid(field, 'malformed');
  }
  if (value.toXDR('base64') !== text) throw invalid(field, 'malformed');
  return value;
}

export function bytes(buffer: Uint8Array): Uint8Array {
  return Uint8Array.from(buffer);
}

/** A G or M address and the account behind it. */
export function accountOf(muxed: xdr.MuxedAccount): DecodedAccount {
  if (muxed.switch().name === 'keyTypeMuxedEd25519') {
    const med = muxed.med25519();
    const key = bytes(med.ed25519());
    return {
      address: encodeMuxedAddress(key, BigInt(med.id().toString())),
      account: encodeStrkey(STRKEY_VERSION.account, key),
    };
  }
  const address = encodeStrkey(STRKEY_VERSION.account, bytes(muxed.ed25519()));
  return { address, account: address };
}

/**
 * The strkey of a Soroban address: G, C or M. Claimable balances and
 * liquidity pools never authorize anything UJIRA signs, so they are refused
 * rather than given a text nothing else here would read.
 */
export function scAddressText(address: xdr.ScAddress, field: string): string {
  switch (address.switch().name) {
    case 'scAddressTypeAccount':
      return encodeStrkey(STRKEY_VERSION.account, bytes(address.accountId().ed25519()));
    case 'scAddressTypeContract':
      // The library declares a contract ID as an array of opaque values,
      // but reads it as the Buffer every other fixed opaque is.
      return encodeStrkey(
        STRKEY_VERSION.contract,
        bytes(address.contractId() as unknown as Uint8Array),
      );
    case 'scAddressTypeMuxedAccount': {
      const muxed = address.muxedAccount();
      return encodeMuxedAddress(bytes(muxed.ed25519()), BigInt(muxed.id().toString()));
    }
    default:
      throw invalid(field, 'unsupported_address');
  }
}

/** Checks the lengths of a signature and its key before either is written anywhere. */
export function checkSignature(parts: Ed25519SignatureParts): {
  readonly publicKey: Buffer;
  readonly signature: Buffer;
} {
  const { publicKey, signature } = parts as Partial<Ed25519SignatureParts>;
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== KEY_BYTES) {
    throw invalid('publicKey', 'invalid_length');
  }
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw invalid('signature', 'invalid_length');
  }
  return { publicKey: Buffer.from(publicKey), signature: Buffer.from(signature) };
}
