// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Chain } from '@ujira/core';

/** CAIP-2 identifiers of the networks UJIRA runs on. A closed set on purpose. */
export const NETWORK_IDS = Object.freeze([
  'stellar:pubnet',
  'stellar:testnet',
  'eip155:42220',
  'eip155:11142220',
] as const);

export type NetworkId = (typeof NETWORK_IDS)[number];

export type StellarNetworkId = Extract<NetworkId, `stellar:${string}`>;
export type EvmNetworkId = Extract<NetworkId, `eip155:${string}`>;

const KNOWN: ReadonlySet<unknown> = new Set<unknown>(NETWORK_IDS);

export function isNetworkId(value: unknown): value is NetworkId {
  return KNOWN.has(value);
}

export function isStellarNetwork(network: NetworkId): network is StellarNetworkId {
  return network.startsWith('stellar:');
}

/** The chain a network belongs to. Kept here so nothing outside branches on it. */
export function chainOf(network: NetworkId): Chain {
  return isStellarNetwork(network) ? 'stellar' : 'celo';
}
