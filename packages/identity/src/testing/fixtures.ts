// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Row builders for tests of the identity service and of the services that
// call it. Every builder takes the tenant first, so a test cannot build a
// row without deciding whose it is.

import { randomUUID } from 'node:crypto';

import type {
  Bytes32,
  CountryCode,
  NetworkId,
  RailCapability,
  RailId,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { accountFromSeed, contractAddress, hexOf, sha256 } from '@ujira/chain-adapter/testing';

import type { RailCatalog } from '../ports.js';
import type {
  IdentityRecord,
  MandateInstanceRecord,
  PayoutMethodRecord,
  RecipientRecord,
} from '../types.js';

/** The test network. Only ever passed through, never compared. */
export const TEST_NETWORK: NetworkId = 'stellar:testnet';
export const WALLET_RAIL: RailId = 'stellar.wallet';
export const ANCHOR_RAIL: RailId = 'stellar.sep31';
export const TEST_NOW = 1_800_000_000n as UnixSeconds;

export function newId(): Uuid {
  return randomUUID() as Uuid;
}

export function newScope(): TenantScope {
  return { principalId: newId(), projectId: newId() };
}

/** 32 bytes derived from a label, so fixtures are stable across runs. */
export function seedOf(label: string): Uint8Array {
  return sha256(new TextEncoder().encode(label));
}

export function bytes32Of(label: string): Bytes32 {
  return hexOf(seedOf(label)) as Bytes32;
}

export function accountOf(label: string): string {
  return accountFromSeed(seedOf(label));
}

export function contractOf(label: string): string {
  return contractAddress(seedOf(label));
}

export function country(code: string): CountryCode {
  return code as CountryCode;
}

export function mandateRow(
  scope: TenantScope,
  patch: Partial<MandateInstanceRecord> = {},
): MandateInstanceRecord {
  return {
    scope,
    id: newId(),
    mandate: {
      network: TEST_NETWORK,
      address: { network: TEST_NETWORK, value: contractOf(`mandate:${scope.projectId}`) },
      specVersion: 1,
    },
    status: 'active',
    recipientMode: 'attested',
    ...patch,
  };
}

export function recipientRow(
  scope: TenantScope,
  patch: Partial<RecipientRecord> = {},
): RecipientRecord {
  const id = patch.id ?? newId();
  return {
    scope,
    id,
    recipientRef: bytes32Of(`recipient:${id}`),
    country: country('NG'),
    status: 'active',
    ...patch,
  };
}

export function methodRow(
  scope: TenantScope,
  recipientId: Uuid,
  patch: Partial<PayoutMethodRecord> = {},
): PayoutMethodRecord {
  const id = patch.id ?? newId();
  return {
    scope,
    id,
    recipientId,
    network: TEST_NETWORK,
    rail: WALLET_RAIL,
    country: country('NG'),
    destination: {
      address: { network: TEST_NETWORK, value: accountOf(`wallet:${id}`) },
      tag: null,
    },
    anchorId: null,
    status: 'active',
    ...patch,
  };
}

export function identityRow(
  scope: TenantScope,
  recipientId: Uuid,
  patch: Partial<IdentityRecord> = {},
): IdentityRecord {
  return {
    scope,
    id: newId(),
    recipientId,
    provider: 'self',
    providerAccount: null,
    status: 'verified',
    assurance: 'document_zk',
    expiresAt: null,
    ...patch,
  };
}

export function railCapability(rail: RailId, patch: Partial<RailCapability> = {}): RailCapability {
  return {
    rail,
    enabled: true,
    deliveryCurrencies: ['USDC'],
    countries: [country('NG')],
    firmQuotes: false,
    requiresRecipientKyc: false,
    ...patch,
  };
}

/** Rails keyed by network and rail id, as a test declares them. */
export class StaticRailCatalog implements RailCatalog {
  readonly #rails = new Map<string, RailCapability>();

  put(network: NetworkId, capability: RailCapability): this {
    this.#rails.set(`${network}/${capability.rail}`, capability);
    return this;
  }

  rail(network: NetworkId, rail: RailId): RailCapability | null {
    return this.#rails.get(`${network}/${rail}`) ?? null;
  }
}

export class ManualClock {
  #now: UnixSeconds;

  constructor(now: UnixSeconds = TEST_NOW) {
    this.#now = now;
  }

  nowSeconds(): UnixSeconds {
    return this.#now;
  }

  set(now: UnixSeconds): void {
    this.#now = now;
  }
}
