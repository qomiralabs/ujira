// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the signer services read to decide, behind ports, so the policies
// are written once and the store behind them can change. The database
// tables these stand for are not built yet; the in-memory versions in
// memory.ts serve tests and fail closed when empty.

import type { CallOptions, NetworkId, TenantScope } from '@ujira/chain-adapter';

export type RecipientMode = 'allowlist' | 'attested' | 'both';

export interface IndexedMandate {
  readonly tenant: TenantScope;
  readonly recipientMode: RecipientMode;
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
export type SponsorshipIntent = 'fee_bump' | 'create_funding_account' | 'recipient_activation';

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
