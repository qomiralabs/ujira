// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the decided rent policy costs, priced with the network's current
// settings:
//
// - a payout record lives until its expiry plus RECORD_TTL_MARGIN_SECONDS,
//   converted to ledgers at the shortest expected close time and never
//   below the network's minimum, and the submitter pays for it;
// - a tombstone is never extended, so it archives when the record's time
//   runs out;
// - the mandate instance and its balance entry are kept alive to
//   instanceTtlExtendLedgers;
// - a restore is priced when it happens, as a fee.
//
// Every amount is stroops in a NativeAmount: integer, never a float.

import type { NetworkId } from '../networks.js';
import type { NativeAmount } from '../types.js';

import { rentFee, rentForChange } from './rent-fees.js';
import type { RentChange } from './rent-fees.js';
import type { SorobanRentSettings } from './rent-settings.js';

/** From the mandate spec: a record outlives its payout's expiry by a day. */
export const RECORD_TTL_MARGIN_SECONDS = 86_400n;
/** From the mandate spec: the expected close time of a Stellar ledger. */
export const STELLAR_LEDGER_SECONDS = 5n;

export interface RentPolicy {
  /** Seconds a payout record outlives its payout's expiry. */
  readonly recordTtlMarginSeconds: bigint;
  /**
   * The shortest ledger close time expected. Converting seconds at the
   * shortest close time gives the most ledgers, so a record never archives
   * before its payout can no longer be executed.
   */
  readonly shortestLedgerCloseSeconds: bigint;
  /** Ledgers the mandate instance and its balance entry are kept alive for. */
  readonly instanceTtlExtendLedgers: bigint;
}

export function xlm(network: NetworkId, stroops: bigint): NativeAmount {
  return { network, asset: 'XLM', amount: stroops, scale: 7 };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator <= 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

/** The ledgers a payout record is created for under the policy. */
export function recordTtlLedgers(
  settings: SorobanRentSettings,
  policy: RentPolicy,
  nowSeconds: bigint,
  expiresAtSeconds: bigint,
): bigint {
  const close = policy.shortestLedgerCloseSeconds > 0n ? policy.shortestLedgerCloseSeconds : 1n;
  const seconds = expiresAtSeconds + policy.recordTtlMarginSeconds - nowSeconds;
  const ledgers = ceilDiv(seconds, close);
  if (ledgers < settings.minPersistentTtlLedgers) return settings.minPersistentTtlLedgers;
  return ledgers > settings.maxEntryTtlLedgers ? settings.maxEntryTtlLedgers : ledgers;
}

export interface PayoutRentCost {
  readonly ttlLedgers: bigint;
  /** Rent for the record's bytes over its TTL. */
  readonly recordRent: NativeAmount;
  /** Writing the record's TTL entry. */
  readonly ttlWrite: NativeAmount;
  readonly total: NativeAmount;
}

/** The rent of creating one payout record, which the submitter pays. */
export function payoutRecordRent(input: {
  readonly settings: SorobanRentSettings;
  readonly policy: RentPolicy;
  readonly currentLedger: bigint;
  readonly nowSeconds: bigint;
  readonly expiresAtSeconds: bigint;
  readonly recordSizeBytes: bigint;
}): PayoutRentCost {
  const { settings, currentLedger } = input;
  const ttlLedgers = recordTtlLedgers(
    settings,
    input.policy,
    input.nowSeconds,
    input.expiresAtSeconds,
  );
  const change: RentChange = {
    persistent: true,
    oldSizeBytes: 0n,
    newSizeBytes: input.recordSizeBytes,
    oldLiveUntilLedger: 0n,
    newLiveUntilLedger: currentLedger + ttlLedgers - 1n,
  };
  const recordRent = rentForChange(settings, change, currentLedger);
  const total = rentFee(settings, [change], currentLedger);
  return {
    ttlLedgers,
    recordRent: xlm(settings.network, recordRent),
    ttlWrite: xlm(settings.network, total - recordRent),
    total: xlm(settings.network, total),
  };
}

/**
 * Replacing a record with its tombstone. The tombstone is smaller and its
 * time to live is not extended, so under the policy this is zero; it is
 * priced rather than assumed, so a policy change shows up here.
 */
export function tombstoneRent(input: {
  readonly settings: SorobanRentSettings;
  readonly currentLedger: bigint;
  readonly recordSizeBytes: bigint;
  readonly tombstoneSizeBytes: bigint;
  readonly liveUntilLedger: bigint;
}): NativeAmount {
  const change: RentChange = {
    persistent: true,
    oldSizeBytes: input.recordSizeBytes,
    newSizeBytes: input.tombstoneSizeBytes,
    oldLiveUntilLedger: input.liveUntilLedger,
    newLiveUntilLedger: input.liveUntilLedger,
  };
  return xlm(input.settings.network, rentFee(input.settings, [change], input.currentLedger));
}

/**
 * Restoring an archived persistent entry: it comes back for the network's
 * minimum TTL, paid like a new entry, and its bytes are read and written again.
 * Left out is what the transaction pays for its own size, 5,167 stroops on
 * testnet on 2026-11-04, since that is the transaction's and no entry's.
 */
export function restoreFee(input: {
  readonly settings: SorobanRentSettings;
  readonly currentLedger: bigint;
  readonly entrySizeBytes: bigint;
}): NativeAmount {
  const { settings, currentLedger, entrySizeBytes } = input;
  const change: RentChange = {
    persistent: true,
    oldSizeBytes: 0n,
    newSizeBytes: entrySizeBytes,
    oldLiveUntilLedger: 0n,
    newLiveUntilLedger: currentLedger + settings.minPersistentTtlLedgers - 1n,
  };
  const read =
    settings.feeDiskReadLedgerEntry + ceilDiv(entrySizeBytes * settings.feeDiskRead1KB, 1024n);
  const write =
    settings.feeWriteLedgerEntry + ceilDiv(entrySizeBytes * settings.feeWrite1KB, 1024n);
  return xlm(settings.network, rentFee(settings, [change], currentLedger) + read + write);
}

/** One persistent entry to keep alive: the instance, the balance entry or the code. */
export interface LiveEntry {
  /** What it pays rent on. For contract code, that is contractCodeRentSizeBytes. */
  readonly sizeBytes: bigint;
  readonly code?: boolean;
  readonly liveUntilLedger: bigint;
}

/**
 * Extending the mandate instance and its balance entry (and the contract
 * code, on the first call after a deploy) to instanceTtlExtendLedgers. An
 * entry already alive that long costs nothing.
 */
export function instanceExtensionRent(input: {
  readonly settings: SorobanRentSettings;
  readonly policy: RentPolicy;
  readonly currentLedger: bigint;
  readonly entries: readonly LiveEntry[];
}): NativeAmount {
  const target = input.currentLedger + input.policy.instanceTtlExtendLedgers - 1n;
  const changes: RentChange[] = input.entries
    .filter((entry) => entry.liveUntilLedger < target)
    .map((entry) => ({
      persistent: true,
      ...(entry.code === true ? { code: true } : {}),
      oldSizeBytes: entry.sizeBytes,
      newSizeBytes: entry.sizeBytes,
      oldLiveUntilLedger: entry.liveUntilLedger,
      newLiveUntilLedger: target,
    }));
  return xlm(input.settings.network, rentFee(input.settings, changes, input.currentLedger));
}
