// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Where every stroop UJIRA spends is written down: fee sponsorship, reserves
// for activations and funding accounts, and executor transactions. Counters
// are always read from these rows and never kept apart from them, so a limit
// and the record it is checked against cannot disagree. The tenant table
// behind this port lives in the db package; the contract in
// testing/sponsorship-ledger.ts is what any implementation must meet.

import type { NetworkId } from '../networks.js';
import type { SponsoredIntent, TenantScope, UnixSeconds } from '../types.js';

export type ReservationState = 'reserved' | 'settled' | 'released';

/** A recipient activation binds one recipient and one account, once each. */
export interface ActivationKey {
  readonly recipientId: string;
  readonly account: string;
}

export interface SponsorshipRow {
  /** Unique across the ledger. */
  readonly reservationId: string;
  readonly scope: TenantScope;
  readonly network: NetworkId;
  readonly intent: SponsoredIntent;
  readonly state: ReservationState;
  /** The most this row may cost, in stroops. */
  readonly maxFeeStroops: bigint;
  /** Set when settled. */
  readonly actualFeeStroops: bigint | null;
  /** The rent the transaction paid, booked with it. Part of what it cost, kept apart for reporting. */
  readonly rentStroops: bigint | null;
  readonly reservedAt: UnixSeconds;
  readonly activation: ActivationKey | null;
}

export interface SponsorshipTotals {
  /** Rows that are not released. */
  readonly count: number;
  /** A settled row counts what it cost, and a reserved one the most it may. */
  readonly stroops: bigint;
}

export interface SponsorshipQuery {
  readonly network: NetworkId;
  /** Rows reserved at or after this time. */
  readonly since: UnixSeconds;
  readonly principalId?: string;
  readonly intents?: readonly SponsoredIntent[];
}

export interface SponsorshipLedger {
  /**
   * Runs `work` with no other reservation on `network` running at the same
   * time, so a limit checked inside it still holds when the row is written.
   * The database store takes a transaction scoped lock.
   */
  atomically<T>(network: NetworkId, work: () => Promise<T>): Promise<T>;
  /** Writes the row, or does nothing and returns false when its reservation ID exists. */
  insert(row: SponsorshipRow): Promise<boolean>;
  /** Platform read: reservation IDs are unique across tenants. */
  get(reservationId: string): Promise<SponsorshipRow | null>;
  /** Moves a reserved row of this tenant to settled. Any other row is left as it is. */
  settle(
    scope: TenantScope,
    reservationId: string,
    actualFeeStroops: bigint,
    rentStroops: bigint | null,
  ): Promise<void>;
  /** Moves a reserved row of this tenant to released. Any other row is left as it is. */
  release(scope: TenantScope, reservationId: string): Promise<void>;
  totals(query: SponsorshipQuery): Promise<SponsorshipTotals>;
  /** Whether a live activation on `network` names this recipient, or on any network this account. */
  activationExists(network: NetworkId, key: ActivationKey): Promise<boolean>;
  /** Adds to the month's uncovered network cost and returns the new total. */
  addShortfall(network: NetworkId, month: string, stroops: bigint): Promise<bigint>;
  shortfall(network: NetworkId, month: string): Promise<bigint>;
}
