// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a service checks before it takes any work. In production no key may
// live with the local provider, since a local key is derived from a seed in
// process memory. Then every pinned address must be the one the signer
// derives, or a mistyped or swapped key would sign for an account nobody
// configured; that check stops the process with SIGNER_ADDRESS_MISMATCH.

import {
  NETWORK_IDS,
  SignerDeniedError,
  pinnedKeys,
  verifyPinnedAddresses,
} from '@ujira/chain-adapter';
import type { CallOptions, NetworksConfig, SignerProvider } from '@ujira/chain-adapter';

/** The provider name configuration gives keys the local signer serves. */
export const LOCAL_PROVIDER = 'local';

export interface SignerStartupOptions {
  readonly signer: SignerProvider;
  readonly config: NetworksConfig;
  /** The deployment environment; process.env.NODE_ENV when left out. */
  readonly nodeEnv?: string | undefined;
  readonly opts: CallOptions;
}

/**
 * Resolves when every key may be used; otherwise throws SignerDeniedError
 * for a local key in production, SignerAddressMismatchError for a pin that
 * differs, or the signer's own error, and the caller must not start.
 */
export async function verifySignerStartup(options: SignerStartupOptions): Promise<void> {
  const nodeEnv = options.nodeEnv ?? process.env['NODE_ENV'];
  if (nodeEnv === 'production') {
    for (const network of NETWORK_IDS) {
      const section = options.config[network];
      if (section === undefined) continue;
      if (pinnedKeys(network, section).some(({ key }) => key.provider === LOCAL_PROVIDER)) {
        throw new SignerDeniedError({ network });
      }
    }
  }
  await verifyPinnedAddresses(options.signer, options.config, options.opts);
}
