// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Row builders for tests of the identity service and of the services that
// call it. Every builder takes the tenant first, so a test cannot build a
// row without deciding whose it is.

import { randomUUID } from 'node:crypto';

import type {
  Bytes32,
  CountryCode,
  MandateSnapshot,
  NetworkId,
  RailCapability,
  RailId,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { chainOf } from '@ujira/chain-adapter';
import { accountFromSeed, contractAddress, hexOf, sha256 } from '@ujira/chain-adapter/testing';
import { tokenAmount } from '@ujira/core';

import { countryPolicyHash } from '../policy.js';
import type { RailCatalog } from '../ports.js';
import type {
  AttemptLegRecord,
  DestinationVerificationRecord,
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

/** The countries test mandates allow unless a test says otherwise. */
export const TEST_COUNTRIES: readonly CountryCode[] = [country('GH'), country('KE'), country('NG')];

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
    countryPolicy: { mode: 'allow', countries: TEST_COUNTRIES },
    countryPolicyHash: countryPolicyHash(TEST_COUNTRIES),
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
    providerRef: null,
    providerStatus: null,
    flowRef: null,
    nullifierHmac: null,
    pendingSession: null,
    failureReason: null,
    rawSha256: null,
    lastCheckedAt: null,
    ...patch,
  };
}

/** A wallet signature proof for the method's current destination. */
export function verificationRow(
  method: PayoutMethodRecord,
  patch: Partial<DestinationVerificationRecord> = {},
): DestinationVerificationRecord {
  return {
    scope: method.scope,
    id: newId(),
    methodId: method.id,
    level: 'wallet_signature',
    destination: method.destination,
    signerKey: method.destination.address.value,
    derivedFrom: null,
    recordedAt: TEST_NOW,
    ...patch,
  };
}

/** Leg 0 of a new attempt paying the method, 2.5 of the test asset. */
export function legRow(
  instance: MandateInstanceRecord,
  method: PayoutMethodRecord,
  patch: Partial<AttemptLegRecord> = {},
): AttemptLegRecord {
  return {
    scope: method.scope,
    attemptId: newId(),
    legIndex: 0,
    mandateInstanceId: instance.id,
    recipientId: method.recipientId,
    methodId: method.id,
    amount: tokenAmount(25_000_000n, 'USDC', chainOf(method.network)),
    ...patch,
  };
}

/** What the chain says about the instance's mandate: live, with this attester. */
export function snapshotOf(
  instance: MandateInstanceRecord,
  attester: Uint8Array | null,
): MandateSnapshot {
  const network = instance.mandate.network;
  const zero = tokenAmount(0n, 'USDC', chainOf(network));
  const budget = tokenAmount(1_000_000_000n, 'USDC', chainOf(network));
  const account = (label: string) => ({ network, value: accountOf(label) });
  return {
    mandate: instance.mandate,
    trustedFactory: true,
    tenantTagMatches: true,
    asset: 'USDC',
    config: {
      principal: account('principal'),
      asset: 'USDC',
      recipientMode: instance.recipientMode,
      tenantTag: bytes32Of(`tenant:${instance.scope.projectId}`),
      agents: [account('agent')],
      approvers: [],
      approvalsRequired: 0,
      guardians: [],
      executors: [account('executor')],
      recovery: [],
      recoveryThreshold: 0,
      limits: {
        totalBudget: budget,
        perPaymentCap: budget,
        perRecipientDailyCap: budget,
        approvalThreshold: zero,
        payoutTtlSeconds: 3600,
        expiresAt: (TEST_NOW + 2_592_000n) as UnixSeconds,
      },
      attester,
      countryPolicyHash: instance.countryPolicyHash,
      maxFeeBps: 0,
      factory: { network, value: contractOf('factory') },
      feeAddress: account('fee'),
      policyEpoch: 3,
      proposedPrincipal: null,
    },
    state: {
      spent: zero,
      pending: zero,
      committed: zero,
      balance: budget,
      free: budget,
      paused: false,
      revoked: false,
      expired: false,
      policyEpoch: 3,
    },
    observedAt: { ledgerOrBlock: 1n, time: TEST_NOW, finality: 'final' },
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
