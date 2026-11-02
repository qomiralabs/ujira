// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The address a factory will deploy a mandate at. The tenant tag is bound to
// that address and goes into the create call itself, so it has to be known
// before the mandate exists. The factory salts the deploy with the principal,
// so one principal's salt can never take another principal's address.

import { createHash } from 'node:crypto';

import { STRKEY_VERSION, encodeStrkey } from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import type { Bytes32 } from '../types.js';
import { addressXdr, scAddressXdr } from './address-xdr.js';
import { stellarNetworkId } from './network-id.js';

const ENVELOPE_TYPE_CONTRACT_ID = 8;
const CONTRACT_ID_PREIMAGE_FROM_ADDRESS = 0;
const BYTES32 = /^0x[0-9a-f]{64}$/;

function u32be(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

/** The C address `factory` deploys the mandate of `principal` and `salt` at. */
export function mandateAddressOf(
  network: StellarNetworkId,
  factory: string,
  principal: string,
  salt: Bytes32,
): string {
  if (typeof salt !== 'string' || !BYTES32.test(salt)) {
    throw new InvalidInputError({ network, issues: ['salt (invalid)'] });
  }
  const deployerSalt = createHash('sha256')
    .update(addressXdr(principal))
    .update(Buffer.from(salt.slice(2), 'hex'))
    .digest();
  const contractId = createHash('sha256')
    .update(u32be(ENVELOPE_TYPE_CONTRACT_ID))
    .update(stellarNetworkId(network))
    .update(u32be(CONTRACT_ID_PREIMAGE_FROM_ADDRESS))
    .update(scAddressXdr(factory))
    .update(deployerSalt)
    .digest();
  return encodeStrkey(STRKEY_VERSION.contract, contractId);
}
