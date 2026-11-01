// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Identity requirements are data: a rail declares whether it needs the
// recipient's KYC, and a project declares what UJIRA itself needs before it
// pays anyone. Nothing here asks which chain a rail or a mandate is on, so
// adding a network never changes this package.

import type {
  Bytes32,
  CountryCode,
  Destination,
  MandateRef,
  NetworkId,
  RailId,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '@ujira/chain-adapter';

/** Where a recipient's verification with one provider stands. */
export const IDENTITY_STATUSES = Object.freeze([
  'pending',
  'verified',
  'rejected',
  'expired',
  'revoked',
] as const);
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

/**
 * How strongly a recipient is known, strongest first. The order is what
 * eligibility reports when more than one verification backs a payout.
 */
export const ASSURANCE_LEVELS = Object.freeze([
  'anchor_kyc',
  'document_zk',
  'principal_kyc',
  'none',
] as const);
export type Assurance = (typeof ASSURANCE_LEVELS)[number];

/**
 * What a project needs before UJIRA pays a recipient. `none` is honoured
 * for allowlist mandates only, where the principal names every destination
 * on chain themselves.
 */
export const RECIPIENT_REQUIREMENTS = Object.freeze([
  'self_pre_kyc',
  'principal_attested',
  'none',
] as const);
export type RecipientRequirement = (typeof RECIPIENT_REQUIREMENTS)[number];

export const DEFAULT_RECIPIENT_REQUIREMENT: RecipientRequirement = 'self_pre_kyc';

/**
 * The systems of record for a verification: Self for the document proof,
 * an anchor's SEP-12 KYC for rails that need it, and the principal for
 * recipients they vouch for themselves.
 */
export const IDENTITY_PROVIDERS = Object.freeze(['self', 'sep12', 'principal'] as const);
export type IdentityProviderName = (typeof IDENTITY_PROVIDERS)[number];

/** Every reason eligibility refuses with. A closed list, so callers can switch on it. */
export const ELIGIBILITY_REFUSAL_REASONS = Object.freeze([
  'MANDATE_INACTIVE',
  'RECIPIENT_INACTIVE',
  'DESTINATION_NOT_BOUND',
  'RAIL_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
  'IDENTITY_REQUIRED',
  'IDENTITY_PENDING',
  'IDENTITY_REJECTED',
  'IDENTITY_EXPIRED',
  'IDENTITY_REVOKED',
] as const);
export type EligibilityRefusalReason = (typeof ELIGIBILITY_REFUSAL_REASONS)[number];

export type RecipientMode = 'allowlist' | 'attested' | 'both';

/** Every call carries the tenant; a row of another tenant is never visible. */
export interface IdentityContext {
  readonly scope: TenantScope;
  /** Per payout trace ID, logged and propagated. */
  readonly correlationId: string;
  readonly signal?: AbortSignal | undefined;
}

export interface EligibilityRequest {
  readonly recipientId: Uuid;
  readonly methodId: Uuid;
  readonly mandateInstanceId: Uuid;
}

export type EligibilityResult =
  | {
      readonly eligible: true;
      /** The strongest verification behind the answer, or none when nothing is required. */
      readonly assurance: Assurance;
      /** When the first verification it relies on lapses, or null if none does. */
      readonly expiresAt: UnixSeconds | null;
    }
  | { readonly eligible: false; readonly reason: EligibilityRefusalReason };

export interface IdentityService {
  /**
   * Whether the recipient may be paid on the method under the mandate
   * instance. Throws IdentityInputError for malformed ids; every business
   * answer, including a disabled provider, is a result rather than a throw.
   */
  eligibility(ctx: IdentityContext, req: EligibilityRequest): Promise<EligibilityResult>;
}

// ---------------------------------------------------------------------------
// Records the identity service reads. Each carries its tenant, and the store
// matches it on every read.

export type RecipientStatus = 'active' | 'inactive';

export interface RecipientRecord {
  readonly scope: TenantScope;
  readonly id: Uuid;
  /** Salted per principal, the reference the mandate sees. */
  readonly recipientRef: Bytes32;
  readonly country: CountryCode;
  readonly status: RecipientStatus;
}

export type PayoutMethodStatus = 'active' | 'disabled';

export interface PayoutMethodRecord {
  readonly scope: TenantScope;
  readonly id: Uuid;
  readonly recipientId: Uuid;
  readonly network: NetworkId;
  readonly rail: RailId;
  readonly country: CountryCode;
  readonly destination: Destination;
  /** The anchor that delivers and runs KYC on rails that need it, otherwise null. */
  readonly anchorId: string | null;
  readonly status: PayoutMethodStatus;
}

export type MandateInstanceStatus = 'pending' | 'active' | 'paused' | 'revoked' | 'expired';

export interface MandateInstanceRecord {
  readonly scope: TenantScope;
  readonly id: Uuid;
  readonly mandate: MandateRef;
  readonly status: MandateInstanceStatus;
  readonly recipientMode: RecipientMode;
}

/** One recipient's verification with one provider. The provider is the system of record. */
export interface IdentityRecord {
  readonly scope: TenantScope;
  readonly id: Uuid;
  readonly recipientId: Uuid;
  readonly provider: IdentityProviderName;
  /** The anchor for SEP-12 rows; null for providers that are not per account. */
  readonly providerAccount: string | null;
  readonly status: IdentityStatus;
  readonly assurance: Assurance;
  readonly expiresAt: UnixSeconds | null;
}

export interface ProjectIdentitySettings {
  readonly recipientRequirement: RecipientRequirement;
}
