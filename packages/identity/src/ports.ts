// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the identity service is given. The store is implemented by the
// database package's repository layer once the recipient and identity
// tables exist; until then the in-memory store in ./testing stands in.

import type {
  ChainAdapter,
  ChainAdapterRegistry,
  NetworkId,
  RailCapability,
  RailId,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { isChainAdapterError } from '@ujira/chain-adapter';

import type { IdentityConfig } from './config.js';
import type {
  IdentityRecord,
  MandateInstanceRecord,
  PayoutMethodRecord,
  RecipientRecord,
} from './types.js';

/**
 * Every read takes the tenant and matches it, so an id that belongs to
 * another tenant reads as absent rather than as someone else's row.
 */
export interface IdentityStore {
  recipient(scope: TenantScope, recipientId: Uuid): Promise<RecipientRecord | null>;
  payoutMethod(scope: TenantScope, methodId: Uuid): Promise<PayoutMethodRecord | null>;
  mandateInstance(scope: TenantScope, instanceId: Uuid): Promise<MandateInstanceRecord | null>;
  /** At most one row per provider and provider account for a recipient. */
  identities(scope: TenantScope, recipientId: Uuid): Promise<readonly IdentityRecord[]>;
  /** The project's stored identity settings as saved, validated by the caller, or null. */
  projectSettings(scope: TenantScope): Promise<unknown>;
}

/** What each rail declares about itself, read from the chain adapter's capabilities. */
export interface RailCatalog {
  rail(network: NetworkId, rail: RailId): RailCapability | null;
}

export interface IdentityServicePorts {
  readonly store: IdentityStore;
  readonly rails: RailCatalog;
  /** The current validated platform configuration. */
  readonly config: () => IdentityConfig;
  readonly clock: { nowSeconds(): UnixSeconds };
}

/**
 * Rails as the adapters declare them. A network with no adapter, or one
 * switched off, has no rails, which eligibility reports as RAIL_UNAVAILABLE.
 */
export function railCatalogFromRegistry(registry: ChainAdapterRegistry): RailCatalog {
  return {
    rail(network, rail) {
      let adapter: ChainAdapter;
      try {
        adapter = registry.get(network);
      } catch (error) {
        // Only the registry's own "no such network" answer means no rails.
        // Anything else is a fault and goes to the caller.
        if (isChainAdapterError(error) && error.code === 'UNSUPPORTED') return null;
        throw error;
      }
      return adapter.capabilities().rails.find((entry) => entry.rail === rail) ?? null;
    },
  };
}
