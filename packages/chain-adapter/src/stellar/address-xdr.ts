// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Soroban's Address::to_xdr, written out from the XDR layout rather than
// taken from a Stellar library: the bytes an address stands for wherever the
// mandate hashes one, such as the attestation message.

import { concat, u32be } from '../bytes.js';
import { KEY_BYTES, STRKEY_VERSION, readStrkey } from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';

const SCV_ADDRESS = 18;
const SC_ADDRESS_TYPE_ACCOUNT = 0;
const SC_ADDRESS_TYPE_CONTRACT = 1;
const PUBLIC_KEY_TYPE_ED25519 = 0;

function payload(address: string, version: number): Uint8Array | undefined {
  const read = readStrkey(address, version, KEY_BYTES);
  return typeof read === 'string' ? undefined : read;
}

/**
 * The SCAddress union: its type, then for an account the key type and key,
 * for a contract the contract ID. Only a G or a C address; an M address is
 * never hashed as such, its base G is.
 */
export function scAddressXdr(address: string): Uint8Array {
  const key = payload(address, STRKEY_VERSION.account);
  if (key !== undefined) {
    return concat(u32be(SC_ADDRESS_TYPE_ACCOUNT), u32be(PUBLIC_KEY_TYPE_ED25519), key);
  }
  const id = payload(address, STRKEY_VERSION.contract);
  if (id !== undefined) return concat(u32be(SC_ADDRESS_TYPE_CONTRACT), id);
  throw new InvalidInputError({ issues: ['address (invalid)'] });
}

/** Address::to_xdr: the ScVal of an address, 44 bytes for an account and 40 for a contract. */
export function addressXdr(address: string): Uint8Array {
  return concat(u32be(SCV_ADDRESS), scAddressXdr(address));
}
