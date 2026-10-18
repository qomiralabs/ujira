// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { NetworksConfig } from './config.js';
import { InvalidInputError, UnsupportedError } from './errors.js';
import { NETWORK_IDS, chainOf, isNetworkId } from './networks.js';
import type { NetworkId } from './networks.js';
import { CHAIN_ADAPTER_INTERFACE_VERSION } from './types.js';
import type { ChainAdapter, ChainAdapterRegistry } from './types.js';

export interface ChainAdapterRegistryOptions {
  readonly adapters: readonly ChainAdapter[];
  /** The current validated snapshot. Read on every call so a config swap applies at once. */
  readonly config: () => NetworksConfig;
}

/** One adapter per network, filtered by what the current config enables. */
export function createChainAdapterRegistry(
  options: ChainAdapterRegistryOptions,
): ChainAdapterRegistry {
  const byNetwork = new Map<NetworkId, ChainAdapter>();
  for (const adapter of options.adapters) {
    // Wiring mistakes surface at startup, not on the first payout.
    if (!isNetworkId(adapter.network)) {
      throw new InvalidInputError({ issues: ['adapter.network (unknown)'] });
    }
    // Typed as the current version, but an adapter built against an older
    // copy of this package can still be passed in at runtime.
    const version: number = adapter.interfaceVersion;
    if (version !== CHAIN_ADAPTER_INTERFACE_VERSION) {
      throw new InvalidInputError({
        network: adapter.network,
        issues: ['adapter.interfaceVersion (unsupported)'],
      });
    }
    // One chain today, so the types say this always matches. Read as a plain
    // string, the check still catches an adapter wired to the wrong network
    // once a second chain exists.
    const chain: string = adapter.chain;
    if (chain !== chainOf(adapter.network)) {
      throw new InvalidInputError({
        network: adapter.network,
        issues: ['adapter.chain (mismatch)'],
      });
    }
    if (byNetwork.has(adapter.network)) {
      throw new InvalidInputError({
        network: adapter.network,
        issues: ['adapter.network (duplicate)'],
      });
    }
    byNetwork.set(adapter.network, adapter);
  }

  const enabled = (config: NetworksConfig, network: NetworkId): boolean =>
    config[network]?.enabled === true;

  return {
    get(network) {
      const adapter = isNetworkId(network) ? byNetwork.get(network) : undefined;
      if (adapter === undefined || !enabled(options.config(), adapter.network)) {
        throw new UnsupportedError({
          network: isNetworkId(network) ? network : null,
        });
      }
      return adapter;
    },
    list() {
      const config = options.config();
      return Object.freeze(
        NETWORK_IDS.flatMap((network) => {
          const adapter = byNetwork.get(network);
          return adapter !== undefined && enabled(config, network) ? [adapter] : [];
        }),
      );
    },
  };
}
