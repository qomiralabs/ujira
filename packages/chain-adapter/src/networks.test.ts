// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the network helpers (networks.ts). NETWORK_IDS is the closed
 * list of CAIP-2 networks: stellar:pubnet and stellar:testnet. isNetworkId
 * accepts exactly those. namespaceOf returns the part before the colon, a
 * member of CHAIN_NAMESPACES, and chainOf maps a network to its chain
 * through a namespace table, so callers never branch on a network.
 */

import { describe, expect, it } from 'vitest';

import { CHAIN_NAMESPACES, NETWORK_IDS, chainOf, isNetworkId, namespaceOf } from './networks.js';

describe('networks', () => {
  it('chainOf maps every Stellar network to stellar', () => {
    for (const network of NETWORK_IDS) expect(chainOf(network)).toBe('stellar');
  });

  it('gives every network a known namespace', () => {
    for (const network of NETWORK_IDS) {
      expect(CHAIN_NAMESPACES).toContain(namespaceOf(network));
    }
  });

  it('recognises exactly the listed networks', () => {
    for (const network of NETWORK_IDS) expect(isNetworkId(network)).toBe(true);
    for (const value of ['stellar:futurenet', 'stellar', 'Stellar:pubnet', '', null, 1]) {
      expect(isNetworkId(value)).toBe(false);
    }
  });
});
