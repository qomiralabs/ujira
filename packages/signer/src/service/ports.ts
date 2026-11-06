// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the signer services read to decide, behind ports, so the policies
// are written once and the store behind them can change. The database
// tables these stand for are not built yet; the in-memory versions in
// memory.ts serve tests and fail closed when empty.

import type { CallOptions, NetworkId, TenantScope, SponsoredIntent } from '@ujira/chain-adapter';

import type { MandateSettlement } from '../unpayable.js';

export type RecipientMode = 'allowlist' | 'attested' | 'both';

/** With what the mandate settles through, as it was deployed, so none of it is ever attested. */
export interface IndexedMandate extends MandateSettlement {
  readonly tenant: TenantScope;
  readonly recipientMode: RecipientMode;
  /**
   * Who may cancel a live payout, as far as the index knows. Absent when it cannot say,
   * and an executor is then refused a cancel, since it might be one of them.
   */
  readonly principal?: string;
  readonly agents?: readonly string[];
}

/** The mandate instances the deposit and event indexer has seen deployed by a trusted factory. */
export interface MandateIndex {
  /**
   * The mandate at `contract` on `network`, when it is indexed and the
   * account `executor` holds its executor role, else null.
   */
  forExecutor(
    network: NetworkId,
    contract: string,
    executor: string,
    opts: CallOptions,
  ): Promise<IndexedMandate | null>;
  /** The mandate at `contract` on `network` when it is indexed, else null. */
  find(network: NetworkId, contract: string, opts: CallOptions): Promise<IndexedMandate | null>;
}

/** Why the fee sponsor set money aside. */
export type SponsorshipIntent = SponsoredIntent;

/** A reserved row of the sponsorship ledger. */
export interface SponsorshipReservation {
  readonly intent: SponsorshipIntent;
  readonly tenant: TenantScope;
  /** The most this reservation lets the sponsor pay, in stroops. */
  readonly maxFeeStroops: bigint;
}

export interface SponsorshipLedger {
  /**
   * The reserved, unspent row for the transaction with this hash on
   * `network`, else null. For a fee bump the hash is the inner
   * transaction's, which the payouts worker knows before it asks.
   */
  reserved(
    network: NetworkId,
    txHash: Uint8Array,
    opts: CallOptions,
  ): Promise<SponsorshipReservation | null>;
}

/** The active row of ujira.managed_signers for one tenant, agent and network. */
export interface ManagedSigner {
  /** The G account the key controls. */
  readonly address: string;
  /** The key manager's id for the key. */
  readonly keyRef: string;
  /** The tenant the key manager's own tags say the key belongs to. */
  readonly keyTags: TenantScope;
}

export interface ManagedSignerStore {
  /** The active key for this tenant, agent and network, else null. */
  active(
    network: NetworkId,
    scope: TenantScope,
    agentId: string,
    opts: CallOptions,
  ): Promise<ManagedSigner | null>;
}

/**
 * How many agent requests a principal may make. Shared across instances in
 * production, because the service scales out and one instance's count would
 * let a principal go over the limit by the number of instances.
 */
export interface PrincipalRateLimiter {
  /** Counts one request and says whether it is within the limit. */
  take(principalId: string, now: bigint, opts: CallOptions): Promise<boolean>;
}

/** The tenant and id of an attestation the identity service recorded first. */
export interface PendingAttestation {
  readonly principalId: string;
  readonly projectId: string;
  readonly attestationId: string;
}

/**
 * The record the identity service writes before it asks for a signature. It
 * answers null for anything else, so with no log at all nothing is signed.
 */
export interface AttestationLog {
  /** The pending row for exactly this 47 byte message, else null. */
  pending(message: Uint8Array, opts: CallOptions): Promise<PendingAttestation | null>;
}

/**
 * The recipient modes of every mandate a managed agent key is seated on, as the chain's
 * role events say. A mode not known yet is an error, not a guess.
 */
export interface ManagedAgentSeats {
  recipientModesOf(
    scope: TenantScope,
    agentId: string,
    opts: { readonly signal: AbortSignal },
  ): Promise<readonly RecipientMode[]>;
}
