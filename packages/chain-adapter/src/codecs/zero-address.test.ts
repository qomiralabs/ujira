// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The all-zero addresses, as the contract's is_zero_address reads them: an
 * address whose 32 byte key or contract ID is all zeros. Stellar has no zero
 * address, but these two are valid addresses nobody holds the key to.
 */

import { describe, expect, it } from 'vitest';

import { addressXdr } from '../stellar/address-xdr.js';
import { accountFromSeed, contractAddress } from '../testing/address.js';

import {
  KEY_BYTES,
  STRKEY_VERSION,
  ZERO_ACCOUNT_ADDRESS,
  ZERO_CONTRACT_ADDRESS,
  encodeMuxedAddress,
  isZeroAddress,
  readStrkey,
} from './strkey.js';

const ZERO_BYTES = new Uint8Array(KEY_BYTES);
const ONE_BYTE_SET = new Uint8Array(KEY_BYTES);
ONE_BYTE_SET[KEY_BYTES - 1] = 1;

describe('the all-zero addresses', () => {
  it('both forms are the same 32 zero bytes', () => {
    expect(readStrkey(ZERO_ACCOUNT_ADDRESS, STRKEY_VERSION.account, KEY_BYTES)).toEqual(ZERO_BYTES);
    expect(readStrkey(ZERO_CONTRACT_ADDRESS, STRKEY_VERSION.contract, KEY_BYTES)).toEqual(
      ZERO_BYTES,
    );
  });

  it('both forms end in those bytes as Address::to_xdr, which is what the contract reads', () => {
    for (const address of [ZERO_ACCOUNT_ADDRESS, ZERO_CONTRACT_ADDRESS]) {
      expect(addressXdr(address).slice(-KEY_BYTES)).toEqual(ZERO_BYTES);
    }
  });

  it('reads the account, the contract and an M address over the account as zero', () => {
    expect(isZeroAddress(ZERO_ACCOUNT_ADDRESS)).toBe(true);
    expect(isZeroAddress(ZERO_CONTRACT_ADDRESS)).toBe(true);
    expect(isZeroAddress(encodeMuxedAddress(ZERO_BYTES, 0n))).toBe(true);
    expect(isZeroAddress(encodeMuxedAddress(ZERO_BYTES, 7n))).toBe(true);
  });

  it('reads any other address as not zero, one bit away included', () => {
    const account = accountFromSeed(new Uint8Array(KEY_BYTES).fill(1));
    expect(isZeroAddress(account)).toBe(false);
    expect(isZeroAddress(contractAddress(ONE_BYTE_SET))).toBe(false);
    expect(isZeroAddress(encodeMuxedAddress(ONE_BYTE_SET, 0n))).toBe(false);
  });

  it('reads text that is no address as not zero, leaving the refusal to the codecs', () => {
    for (const text of ['', 'G', 'not an address', ZERO_ACCOUNT_ADDRESS.toLowerCase()]) {
      expect(isZeroAddress(text)).toBe(false);
    }
  });
});
