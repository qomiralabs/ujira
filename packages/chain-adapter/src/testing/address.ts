// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Addresses on the fake chain are Stellar strkeys: G for an account, C for a
// contract. The mandate needs their bytes in two places, the attestation
// message and the check that the attester key is no role account's key, so
// both read them the way the contract does, as Address::to_xdr, through the
// adapter's own encoder.

import { InvalidInputError } from '../errors.js';
import {
  KEY_BYTES,
  STRKEY_VERSION,
  encodeStrkey,
  isAccountAddress,
  isContractAddress,
  readStrkey,
} from '../codecs/strkey.js';
import { addressXdr, scAddressXdr } from '../stellar/address-xdr.js';

import { ed25519PublicKey, sha256, u32be } from './bytes.js';

export { addressXdr };

const ENVELOPE_TYPE_CONTRACT_ID = 8;
const CONTRACT_ID_PREIMAGE_FROM_ADDRESS = 0;

export function isAddress(text: string): boolean {
  return isAccountAddress(text) || isContractAddress(text);
}

/** Throws unless `text` is a G or C address, naming the field it came in. */
export function checkAddress(field: string, text: unknown): string {
  if (typeof text !== 'string' || !isAddress(text)) {
    throw new InvalidInputError({ issues: [`${field} (invalid)`] });
  }
  return text;
}

export function accountAddress(publicKey: Uint8Array): string {
  return encodeStrkey(STRKEY_VERSION.account, publicKey);
}

export function contractAddress(contractId: Uint8Array): string {
  return encodeStrkey(STRKEY_VERSION.contract, contractId);
}

/** A fresh account address whose key is the ed25519 key of `seed`. */
export function accountFromSeed(seed: Uint8Array): string {
  return accountAddress(ed25519PublicKey(seed));
}

/** The ed25519 key of an account address, or null for a contract. */
export function accountKeyOf(address: string): Uint8Array | null {
  const read = readStrkey(address, STRKEY_VERSION.account, KEY_BYTES);
  return typeof read === 'string' ? null : read;
}

/**
 * Where a deployer puts a contract for a salt, as the Stellar host derives
 * it: the SHA-256 of the contract ID preimage for that network.
 */
export function deployedAddress(networkId: Uint8Array, deployer: string, salt: Uint8Array): string {
  return contractAddress(
    sha256(
      u32be(ENVELOPE_TYPE_CONTRACT_ID),
      networkId,
      u32be(CONTRACT_ID_PREIMAGE_FROM_ADDRESS),
      scAddressXdr(deployer),
      salt,
    ),
  );
}
