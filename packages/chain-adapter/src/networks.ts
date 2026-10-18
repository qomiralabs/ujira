// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Chain } from '@ujira/core';

import { CHAIN_NAMESPACES } from './chain-modules.js';
import type { ChainNamespace } from './chain-modules.js';

export { CHAIN_NAMESPACES };
export type { ChainNamespace };

/** CAIP-2 identifiers of the networks UJIRA runs on. A closed set on purpose. */
export const NETWORK_IDS = Object.freeze(['stellar:pubnet', 'stellar:testnet'] as const);

export type NetworkId = (typeof NETWORK_IDS)[number];

export type StellarNetworkId = Extract<NetworkId, `stellar:${string}`>;

const KNOWN: ReadonlySet<unknown> = new Set<unknown>(NETWORK_IDS);

export function isNetworkId(value: unknown): value is NetworkId {
  return KNOWN.has(value);
}

// The chain each namespace settles on. A table rather than a branch, so a
// second chain is one more entry and no caller learns which chain it is on.
const CHAIN_OF_NAMESPACE: Readonly<Record<ChainNamespace, Chain>> = Object.freeze({
  stellar: 'stellar',
});

/** The CAIP-2 namespace of a network, the part before the colon. */
export function namespaceOf(network: NetworkId): ChainNamespace {
  return network.slice(0, network.indexOf(':')) as ChainNamespace;
}

/** The chain a network belongs to. Kept here so nothing outside branches on it. */
export function chainOf(network: NetworkId): Chain {
  return CHAIN_OF_NAMESPACE[namespaceOf(network)];
}
