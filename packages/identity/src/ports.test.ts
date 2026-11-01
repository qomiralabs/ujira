// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type {
  ChainAdapter,
  ChainAdapterRegistry,
  NetworkId,
  RailCapability,
} from '@ujira/chain-adapter';
import { RpcTimeoutError, UnsupportedError } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import { railCatalogFromRegistry } from './ports.js';
import { ANCHOR_RAIL, TEST_NETWORK, WALLET_RAIL, railCapability } from './testing/index.js';

const OTHER_NETWORK: NetworkId = 'stellar:pubnet';

function registry(get: (network: NetworkId) => ChainAdapter): ChainAdapterRegistry {
  return { get, list: () => [] };
}

function adapterWith(rails: RailCapability[]): ChainAdapter {
  // Only capabilities() is read; the rest of the adapter is never touched.
  return { capabilities: () => ({ rails }) } as unknown as ChainAdapter;
}

describe('railCatalogFromRegistry', () => {
  it('reads a rail from the adapter of its network', () => {
    const wallet = railCapability(WALLET_RAIL);
    const catalog = railCatalogFromRegistry(registry(() => adapterWith([wallet])));
    expect(catalog.rail(TEST_NETWORK, WALLET_RAIL)).toBe(wallet);
    expect(catalog.rail(TEST_NETWORK, ANCHOR_RAIL)).toBeNull();
  });

  it('a network with no adapter has no rails', () => {
    const catalog = railCatalogFromRegistry(
      registry(() => {
        throw new UnsupportedError({ network: OTHER_NETWORK });
      }),
    );
    expect(catalog.rail(OTHER_NETWORK, WALLET_RAIL)).toBeNull();
  });

  it('any other failure reaches the caller', () => {
    const catalog = railCatalogFromRegistry(
      registry(() => {
        throw new RpcTimeoutError();
      }),
    );
    expect(() => catalog.rail(TEST_NETWORK, WALLET_RAIL)).toThrow(RpcTimeoutError);
  });
});
