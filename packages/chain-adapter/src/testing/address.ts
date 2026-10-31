// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Addresses on the fake chain are Stellar strkeys: G for an account, C for a
// contract. The mandate needs their bytes in two places, the attestation
// message and the check that the attester key is no role account's key, so
// both read them the way the contract does, as Address::to_xdr.

import { InvalidInputError } from '../errors.js';
import {
  KEY_BYTES,
  STRKEY_VERSION,
  encodeStrkey,
  isAccountAddress,
  isContractAddress,
  readStrkey,
} from '../codecs/strkey.js';

import { concat, ed25519PublicKey, sha256, u32be } from './bytes.js';

const SCV_ADDRESS = 18;
const SC_ADDRESS_TYPE_ACCOUNT = 0;
const SC_ADDRESS_TYPE_CONTRACT = 1;
const PUBLIC_KEY_TYPE_ED25519 = 0;
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

function payload(address: string, version: number): Uint8Array | undefined {
  const read = readStrkey(address, version, KEY_BYTES);
  return typeof read === 'string' ? undefined : read;
}

/** The ed25519 key of an account address, or null for a contract. */
export function accountKeyOf(address: string): Uint8Array | null {
  return payload(address, STRKEY_VERSION.account) ?? null;
}

// The SCAddress union: its type, then for an account the key type and key,
// for a contract the contract ID.
function scAddress(address: string): Uint8Array {
  const key = payload(address, STRKEY_VERSION.account);
  if (key !== undefined) {
    return concat(u32be(SC_ADDRESS_TYPE_ACCOUNT), u32be(PUBLIC_KEY_TYPE_ED25519), key);
  }
  const id = payload(address, STRKEY_VERSION.contract);
  if (id !== undefined) return concat(u32be(SC_ADDRESS_TYPE_CONTRACT), id);
  throw new InvalidInputError({ issues: ['address (invalid)'] });
}

/**
 * Address::to_xdr: the ScVal of an address, 44 bytes for an account and 40
 * for a contract.
 */
export function addressXdr(address: string): Uint8Array {
  return concat(u32be(SCV_ADDRESS), scAddress(address));
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
      scAddress(deployer),
      salt,
    ),
  );
}
