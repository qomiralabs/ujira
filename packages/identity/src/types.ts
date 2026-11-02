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
import type { TokenAmount } from '@ujira/core';

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

/** Pay recipients in the listed countries only, or anywhere but them. */
export type CountryPolicyMode = 'allow' | 'deny';

export interface CountryPolicy {
  readonly mode: CountryPolicyMode;
  readonly countries: readonly CountryCode[];
}

export interface MandateInstanceRecord {
  readonly scope: TenantScope;
  readonly id: Uuid;
  readonly mandate: MandateRef;
  readonly status: MandateInstanceStatus;
  readonly recipientMode: RecipientMode;
  /** The principal's country list. The chain only ever sees its hash. */
  readonly countryPolicy: CountryPolicy;
  /** The hash stored when the instance was created, of the list above. */
  readonly countryPolicyHash: Bytes32;
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
  /** The provider's id for the verification, such as Self's verification id. */
  readonly providerRef: string | null;
  /** The provider's own word for the last result, kept for support. Never branched on. */
  readonly providerStatus: string | null;
  /** The provider flow and version that produced the result. */
  readonly flowRef: string | null;
  /** Hex HMAC of the provider's nullifier. The nullifier itself is never stored. */
  readonly nullifierHmac: string | null;
  /** The open session the recipient was sent to, reused until it expires. */
  readonly pendingSession: PendingSession | null;
  /** A code such as duplicate_person or session_expired, never a provider message. */
  readonly failureReason: string | null;
  /** Hex SHA-256 of the last raw result body. The body itself is discarded. */
  readonly rawSha256: string | null;
  /** When the provider completed the result last applied, to drop older ones. */
  readonly lastCheckedAt: UnixSeconds | null;
}

export interface PendingSession {
  readonly sessionId: string;
  /** The provider's hosted page. Carries no personal data. */
  readonly url: string;
  readonly expiresAt: UnixSeconds;
}

export interface ProjectIdentitySettings {
  readonly recipientRequirement: RecipientRequirement;
}

// ---------------------------------------------------------------------------
// Destination evidence and attestations

/**
 * How a destination was shown to be the recipient's. A wallet signature is
 * a proof signed by the destination key; a session wallet was recorded in an
 * embed session; a partner confirmed an anchor deposit address; a forwarder
 * was derived from a wallet verified at one of the wallet levels; and in
 * allowlist mode the principal asserted it themselves.
 */
export const VERIFICATION_LEVELS = Object.freeze([
  'wallet_signature',
  'wallet_session',
  'partner_confirmed',
  'forwarder_derived',
  'principal_asserted',
] as const);
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/** Append only: the latest row for a method is its current evidence. */
export interface DestinationVerificationRecord {
  readonly scope: TenantScope;
  readonly id: Uuid;
  readonly methodId: Uuid;
  readonly level: VerificationLevel;
  readonly destination: Destination;
  /** The key that signed a wallet signature proof, as the chain writes it; otherwise null. */
  readonly signerKey: string | null;
  /** For a forwarder: the wallet verification it was built on. Otherwise null. */
  readonly derivedFrom: Uuid | null;
  readonly recordedAt: UnixSeconds;
}

/** One leg of a payout attempt, as the payouts service recorded it. */
export interface AttemptLegRecord {
  readonly scope: TenantScope;
  readonly attemptId: Uuid;
  /** 0 to 255, the byte the leg key ends with. */
  readonly legIndex: number;
  readonly mandateInstanceId: Uuid;
  readonly recipientId: Uuid;
  readonly methodId: Uuid;
  readonly amount: TokenAmount;
}

/**
 * Every reason attest refuses with, in the order of the checks that give
 * them. A closed list, so callers can switch on it.
 */
export const ATTESTATION_REFUSAL_REASONS = Object.freeze([
  'MANDATE_INACTIVE',
  'WRONG_RECIPIENT_MODE',
  'ATTESTER_MISMATCH',
  'RECIPIENT_INACTIVE',
  'DESTINATION_NOT_BOUND',
  'DESTINATION_UNVERIFIED',
  'DESTINATION_NOT_RECEIVABLE',
  'RAIL_UNAVAILABLE',
  'IDENTITY_REQUIRED',
  'COUNTRY_NOT_ALLOWED',
  'POLICY_HASH_MISMATCH',
  'VALIDITY_TOO_SHORT',
  'PROVIDER_UNAVAILABLE',
] as const);
export type AttestationRefusalReason = (typeof ATTESTATION_REFUSAL_REASONS)[number];

export interface AttestRequest {
  readonly attemptId: Uuid;
  readonly legIndex: number;
  readonly mandateInstanceId: Uuid;
  readonly methodId: Uuid;
}

export interface SignedAttestation {
  /** The attestation row. */
  readonly id: Uuid;
  readonly legIndex: number;
  readonly validUntil: UnixSeconds;
  /** 64 bytes of ed25519 over the 47 byte attestation message. */
  readonly signature: Uint8Array;
  /** The attester's 32 byte public key that made it. */
  readonly publicKey: Uint8Array;
  /** SHA-256 of the signed message, the row's unique digest. */
  readonly digest: Bytes32;
}

export type AttestResult =
  | { readonly attested: true; readonly attestation: SignedAttestation }
  | {
      readonly attested: false;
      readonly reason: AttestationRefusalReason;
      /**
       * The narrower cause where one exists: the receivability reason for
       * DESTINATION_NOT_RECEIVABLE and the eligibility reason for
       * IDENTITY_REQUIRED. Codes only, never personal data.
       */
      readonly detail: string | null;
    };

export interface AttestationService {
  /**
   * Internal only, never a public route. Runs the checks in a fixed order,
   * records the attestation as pending, and only then asks the attester to
   * sign. A refusal writes nothing and signs nothing.
   */
  attest(ctx: IdentityContext, req: AttestRequest): Promise<AttestResult>;
}

export type AttestationStatus = 'pending' | 'signed' | 'failed';

/** Append only, except that status moves once from pending to signed or failed. */
export interface AttestationRecord {
  readonly scope: TenantScope;
  readonly id: Uuid;
  readonly attemptId: Uuid;
  readonly legIndex: number;
  readonly mandateInstanceId: Uuid;
  readonly recipientId: Uuid;
  readonly methodId: Uuid;
  readonly destination: Destination;
  readonly countryPolicyHash: Bytes32;
  readonly policyEpoch: bigint;
  readonly validUntil: UnixSeconds;
  /** 0x and the attester's public key in hex. */
  readonly attesterKeyId: string;
  /** The 47 byte message the attester is about to sign. */
  readonly message: Uint8Array;
  readonly digest: Bytes32;
  readonly status: AttestationStatus;
  readonly signature: Uint8Array | null;
  /** An error code when signing failed, never a message. */
  readonly failureCode: string | null;
}
