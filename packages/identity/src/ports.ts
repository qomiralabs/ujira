// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the identity service is given. The store is implemented by the
// database package's repository layer once the recipient and identity
// tables exist; until then the in-memory store in ./testing stands in.

import type {
  AttestationFields,
  AttesterSigner,
  CallOptions,
  ChainAdapter,
  ChainAdapterRegistry,
  Destination,
  MandateRef,
  MandateSnapshot,
  NetworkId,
  RailCapability,
  RailId,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';
import { isChainAdapterError } from '@ujira/chain-adapter';
import type { TokenAmount, TokenAsset } from '@ujira/core';

import type { IdentityConfig } from './config.js';
import type {
  AttemptLegRecord,
  AttestationRecord,
  DestinationVerificationRecord,
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
  /** The method's most recent destination verification, or null if it has none. */
  latestVerification(
    scope: TenantScope,
    methodId: Uuid,
  ): Promise<DestinationVerificationRecord | null>;
  verification(
    scope: TenantScope,
    verificationId: Uuid,
  ): Promise<DestinationVerificationRecord | null>;
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

// ---------------------------------------------------------------------------
// Attestation

/** Why a destination cannot take the payout asset now. */
export const NOT_RECEIVABLE_REASONS = Object.freeze([
  'ACCOUNT_NOT_FOUND',
  'NO_TRUSTLINE',
  'TRUSTLINE_NOT_AUTHORIZED',
  'TRUSTLINE_LIMIT',
  'DESTINATION_IS_ISSUER',
] as const);
export type NotReceivableReason = (typeof NOT_RECEIVABLE_REASONS)[number];

/** Whether the key that signed the destination's proof still signs for it. */
export type ProofSignerState = 'current' | 'not_current' | 'not_applicable';

export interface CheckDestinationRequest {
  readonly destination: Destination;
  readonly asset: TokenAsset;
  readonly amount?: TokenAmount;
  /** The key recorded with the destination's proof, when it has one. */
  readonly proofSigner?: string;
}

export type DestinationCheck =
  | { readonly receivable: true; readonly proofSigner: ProofSignerState }
  | {
      readonly receivable: false;
      readonly reason: NotReceivableReason;
      readonly proofSigner: ProofSignerState;
    };

/**
 * The part of the chain adapter the attester uses. readMandate is the
 * adapter's own; attestationMessage and checkDestination are the methods the
 * adapter gains for attestation and destination checks, typed here as they
 * are specified so this package does not wait on them. Once the adapter has
 * them, a registry's adapter satisfies this interface as it is.
 */
export interface AttestationChain {
  readMandate(
    req: { readonly scope: TenantScope; readonly mandate: MandateRef },
    opts: CallOptions,
  ): Promise<MandateSnapshot>;
  /** Pure: the 47 byte message the mandate verifies, built from the fields. */
  attestationMessage(fields: AttestationFields): Uint8Array;
  /** Read fresh from the chain on every call, never cached. */
  checkDestination(req: CheckDestinationRequest, opts: CallOptions): Promise<DestinationCheck>;
}

/**
 * Where attestations are recorded. The attester signs only a message that is
 * pending here, so the identity service and the signer must both agree.
 */
export interface AttestationLog {
  /**
   * Resolves only once the pending row is committed and visible to the
   * signer. Throws AttestationConflictError when the digest and key exist.
   */
  insertPending(row: AttestationRecord): Promise<void>;
  /** Pending to signed, once. Throws AttestationStateError otherwise. */
  markSigned(scope: TenantScope, attestationId: Uuid, signature: Uint8Array): Promise<void>;
  /** Pending to failed, once. Throws AttestationStateError otherwise. */
  markFailed(scope: TenantScope, attestationId: Uuid, failureCode: string): Promise<void>;
}

/** The payouts service's record of each attempt's legs. */
export interface PayoutLegSource {
  leg(scope: TenantScope, attemptId: Uuid, legIndex: number): Promise<AttemptLegRecord | null>;
}

export interface AttestationServicePorts extends IdentityServicePorts {
  /** The chain the mandate instance is on. */
  chain(network: NetworkId): AttestationChain;
  /** One ed25519 attester key per environment. */
  readonly signer: AttesterSigner;
  readonly log: AttestationLog;
  readonly legs: PayoutLegSource;
}
