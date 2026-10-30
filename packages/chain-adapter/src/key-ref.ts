// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Configuration pins the account each signing key must control. A key
// swapped or mistyped in the key manager would otherwise sign for an
// account nobody configured, and the first sign of it would be a failed or
// misdirected transaction, so every pin is checked against the signer's own
// answer before a service takes any work.

import type { KeyRef, NetworksConfig, StellarNetworkConfig } from './config.js';
import { SignerAddressMismatchError } from './errors.js';
import { NETWORK_IDS } from './networks.js';
import type { NetworkId } from './networks.js';
import type { SignerProvider, SignerRef } from './signer.js';
import type { CallOptions } from './types.js';

export interface PinnedKey {
  readonly ref: SignerRef;
  readonly key: KeyRef;
}

/** Every key one network pins, with the ref the signer serves it under. */
export function pinnedKeys(network: NetworkId, config: StellarNetworkConfig): readonly PinnedKey[] {
  return Object.freeze([
    ...config.executor.keys.map((key): PinnedKey => ({
      ref: { kind: 'executor', network, keyId: key.keyId },
      key,
    })),
    { ref: { kind: 'fee_sponsor', network }, key: config.feeSponsor.key },
    ...config.sep10.map(({ anchorId, key }): PinnedKey => ({
      ref: { kind: 'sep10', network, anchorId },
      key,
    })),
  ]);
}

/**
 * Checks every pinned key of every network in the snapshot, enabled or not,
 * so enabling one later needs no second check. Throws
 * SignerAddressMismatchError at the first key whose account differs from
 * its pin, and lets signer failures through as they are. A config swap
 * that changes a key needs the check run again.
 */
export async function verifyPinnedAddresses(
  signer: SignerProvider,
  config: NetworksConfig,
  opts: CallOptions,
): Promise<void> {
  for (const network of NETWORK_IDS) {
    const section = config[network];
    if (section === undefined) continue;
    for (const { ref, key } of pinnedKeys(network, section)) {
      // One at a time: there are few keys, and a mismatch should stop the
      // check before any later key is asked for.
      const actual = await signer.address(ref, opts);
      if (actual.network !== network || actual.value !== key.address) {
        throw new SignerAddressMismatchError({ network });
      }
    }
  }
}
