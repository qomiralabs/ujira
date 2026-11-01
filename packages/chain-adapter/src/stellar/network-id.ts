// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { sha256, utf8 } from '../bytes.js';
import type { StellarNetworkId } from '../networks.js';

/** The passphrase of each Stellar network, fixed by the network itself. */
export const STELLAR_PASSPHRASES: Readonly<Record<StellarNetworkId, string>> = Object.freeze({
  'stellar:pubnet': 'Public Global Stellar Network ; September 2015',
  'stellar:testnet': 'Test SDF Network ; September 2015',
});

/** The network ID a contract reads from its environment: the SHA-256 of the passphrase. */
export function stellarNetworkId(network: StellarNetworkId): Uint8Array {
  return sha256(utf8(STELLAR_PASSPHRASES[network]));
}
