// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every Stellar signature is over a hash that starts from the network ID,
// the SHA-256 of the network passphrase, which is what stops a testnet
// signature being replayed on pubnet. A table keyed by network rather than
// a branch, as everywhere else in the adapter.

import { createHash } from 'node:crypto';

import { Networks } from '@stellar/stellar-base';

import { InvalidInputError } from '../errors.js';
import { isNetworkId } from '../networks.js';
import type { NetworkId } from '../networks.js';

const PASSPHRASES: Readonly<Record<NetworkId, string>> = Object.freeze({
  'stellar:pubnet': Networks.PUBLIC,
  'stellar:testnet': Networks.TESTNET,
});

/** Throws unless `network` is one UJIRA runs on, before any input is read. */
export function checkNetwork(network: unknown): NetworkId {
  if (!isNetworkId(network)) throw new InvalidInputError({ issues: ['network (invalid)'] });
  return network;
}

export function networkPassphrase(network: NetworkId): string {
  return PASSPHRASES[checkNetwork(network)];
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(bytes).digest());
}

/** The 32 byte network ID every signature payload on `network` starts from. */
export function networkIdOf(network: NetworkId): Uint8Array {
  return sha256(Buffer.from(networkPassphrase(network), 'utf8'));
}
