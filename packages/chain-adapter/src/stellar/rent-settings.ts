// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The network's rent settings, read from its config setting ledger entries.
// The XDR of the four entries rent needs is decoded by hand, as the strkey
// codec is, so pricing rent needs no Stellar library. Testnet and mainnet
// carry different values, and governance can change them at any ledger, so
// the model always prices with what the network says now.

import { InvalidInputError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';

const LEDGER_ENTRY_CONTRACT_CODE = 7;
const LEDGER_ENTRY_CONFIG_SETTING = 8;
const MEMORY_COST_SETTING_ID = 7;
/** The number of fields in ContractCodeCostInputs. */
export const CONTRACT_CODE_COST_INPUTS = 10;

/** The config setting ids rent reads, from the Stellar XDR. */
export const RENT_CONFIG_SETTING_IDS = Object.freeze({
  contractLedgerCostV0: 2,
  stateArchival: 10,
  liveSorobanStateSizeWindow: 12,
  contractLedgerCostExtV0: 15,
} as const);

export interface SorobanRentSettings {
  readonly network: StellarNetworkId;
  /** The ledger the settings were read at. */
  readonly ledger: bigint;
  /** Stroops per ledger entry read from disk; a restore reads what it brings back. */
  readonly feeDiskReadLedgerEntry: bigint;
  /** Stroops per 1 KB read from disk. */
  readonly feeDiskRead1KB: bigint;
  readonly minPersistentTtlLedgers: bigint;
  readonly maxEntryTtlLedgers: bigint;
  readonly persistentRentRateDenominator: bigint;
  readonly tempRentRateDenominator: bigint;
  /** Stroops per ledger entry written; charged for each TTL entry write. */
  readonly feeWriteLedgerEntry: bigint;
  /** Stroops per 1 KB written. */
  readonly feeWrite1KB: bigint;
  readonly sorobanStateTargetSizeBytes: bigint;
  readonly rentFee1KBStateSizeLow: bigint;
  readonly rentFee1KBStateSizeHigh: bigint;
  readonly stateRentFeeGrowthFactor: number;
  /** The mean of the network's live state size window. */
  readonly averageStateSizeBytes: bigint;
}

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  private take(n: number): DataView {
    if (this.at + n > this.bytes.length) throw malformed();
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.at, n);
    this.at += n;
    return view;
  }

  u32(): number {
    return this.take(4).getUint32(0);
  }

  i64(): bigint {
    return this.take(8).getBigInt64(0);
  }

  u64(): bigint {
    return this.take(8).getBigUint64(0);
  }

  end(): void {
    if (this.at !== this.bytes.length) throw malformed();
  }
}

function malformed(): InvalidInputError {
  return new InvalidInputError({ issues: ['rentSettings (malformed)'] });
}

function readEntry(base64: string): { readonly id: number; readonly body: Reader } {
  const reader = new Reader(Uint8Array.from(Buffer.from(base64, 'base64')));
  if (reader.u32() !== LEDGER_ENTRY_CONFIG_SETTING) throw malformed();
  return { id: reader.u32(), body: reader };
}

/**
 * Decodes the LedgerEntryData of the four config settings rent depends on,
 * as getLedgerEntries returns them, in any order. Throws InvalidInputError
 * when one is missing, repeated, or not the layout this decoder knows.
 */
export function decodeRentSettings(
  network: StellarNetworkId,
  ledger: bigint,
  entries: readonly string[],
): SorobanRentSettings {
  const ids = RENT_CONFIG_SETTING_IDS;
  const seen = new Set<number>();
  // Filled field by field as the entries arrive, in whatever order.
  const found: { -readonly [K in keyof SorobanRentSettings]?: SorobanRentSettings[K] } = {};
  for (const entry of entries) {
    const { id, body: r } = readEntry(entry);
    if (seen.has(id)) throw malformed();
    seen.add(id);
    if (id === ids.contractLedgerCostV0) {
      for (let i = 0; i < 8; i += 1) r.u32(); // read and write limits
      found.feeDiskReadLedgerEntry = r.i64();
      found.feeWriteLedgerEntry = r.i64();
      found.feeDiskRead1KB = r.i64();
      found.sorobanStateTargetSizeBytes = r.i64();
      found.rentFee1KBStateSizeLow = r.i64();
      found.rentFee1KBStateSizeHigh = r.i64();
      found.stateRentFeeGrowthFactor = r.u32();
    } else if (id === ids.stateArchival) {
      found.maxEntryTtlLedgers = BigInt(r.u32());
      r.u32(); // minTemporaryTTL
      found.minPersistentTtlLedgers = BigInt(r.u32());
      found.persistentRentRateDenominator = r.i64();
      found.tempRentRateDenominator = r.i64();
      for (let i = 0; i < 5; i += 1) r.u32(); // archival and eviction tuning
    } else if (id === ids.liveSorobanStateSizeWindow) {
      const count = r.u32();
      if (count === 0 || count > 10_000) throw malformed();
      let sum = 0n;
      for (let i = 0; i < count; i += 1) sum += r.u64();
      found.averageStateSizeBytes = sum / BigInt(count);
    } else if (id === ids.contractLedgerCostExtV0) {
      r.u32(); // txMaxFootprintEntries
      found.feeWrite1KB = r.i64();
    } else {
      throw malformed();
    }
    r.end();
  }
  const {
    feeDiskReadLedgerEntry,
    feeDiskRead1KB,
    minPersistentTtlLedgers,
    maxEntryTtlLedgers,
    persistentRentRateDenominator,
    tempRentRateDenominator,
    feeWriteLedgerEntry,
    feeWrite1KB,
    sorobanStateTargetSizeBytes,
    rentFee1KBStateSizeLow,
    rentFee1KBStateSizeHigh,
    stateRentFeeGrowthFactor,
    averageStateSizeBytes,
  } = found;
  if (
    feeDiskReadLedgerEntry === undefined ||
    feeDiskRead1KB === undefined ||
    minPersistentTtlLedgers === undefined ||
    maxEntryTtlLedgers === undefined ||
    persistentRentRateDenominator === undefined ||
    tempRentRateDenominator === undefined ||
    feeWriteLedgerEntry === undefined ||
    feeWrite1KB === undefined ||
    sorobanStateTargetSizeBytes === undefined ||
    rentFee1KBStateSizeLow === undefined ||
    rentFee1KBStateSizeHigh === undefined ||
    stateRentFeeGrowthFactor === undefined ||
    averageStateSizeBytes === undefined
  ) {
    throw new InvalidInputError({ issues: ['rentSettings (incomplete)'] });
  }
  if (persistentRentRateDenominator <= 0n || tempRentRateDenominator <= 0n) throw malformed();
  return {
    network,
    ledger,
    feeDiskReadLedgerEntry,
    feeDiskRead1KB,
    minPersistentTtlLedgers,
    maxEntryTtlLedgers,
    persistentRentRateDenominator,
    tempRentRateDenominator,
    feeWriteLedgerEntry,
    feeWrite1KB,
    sorobanStateTargetSizeBytes,
    rentFee1KBStateSizeLow,
    rentFee1KBStateSizeHigh,
    stateRentFeeGrowthFactor,
    averageStateSizeBytes,
  };
}

/** One memory cost from the network's cost model. */
export interface MemoryCost {
  readonly constTerm: bigint;
  readonly linearTerm: bigint;
}

/** What rent needs from a contract code entry. */
export interface ContractCodeCost {
  /** The size of its LedgerEntryData. */
  readonly dataXdrBytes: bigint;
  /** ContractCodeCostInputs, in XDR order. */
  readonly costInputs: readonly number[];
}

/**
 * Decodes the memory cost table from config setting 7, which prices holding a
 * parsed contract in memory.
 */
export function decodeMemoryCosts(base64: string): readonly MemoryCost[] {
  const { id, body: r } = readEntry(base64);
  if (id !== MEMORY_COST_SETTING_ID) throw malformed();
  const count = r.u32();
  if (count > 10_000) throw malformed();
  const costs: MemoryCost[] = [];
  for (let i = 0; i < count; i += 1) {
    r.u32(); // ext
    costs.push({ constTerm: r.i64(), linearTerm: r.i64() });
  }
  r.end();
  return costs;
}

/**
 * Decodes a contract code LedgerEntryData far enough to price its rent. A code
 * entry with no cost inputs predates them, and is refused rather than guessed.
 */
export function decodeContractCodeEntry(base64: string): ContractCodeCost {
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  const r = new Reader(bytes);
  if (r.u32() !== LEDGER_ENTRY_CONTRACT_CODE) throw malformed();
  if (r.u32() !== 1) throw malformed();
  r.u32(); // ExtensionPoint of the entry's own extension
  r.u32(); // ExtensionPoint of the cost inputs
  const costInputs: number[] = [];
  for (let i = 0; i < CONTRACT_CODE_COST_INPUTS; i += 1) costInputs.push(r.u32());
  return { dataXdrBytes: BigInt(bytes.length), costInputs };
}

/**
 * The settings governance changes, as one string. The ledger and the state
 * size window move on their own every few minutes, so they are left out: a
 * change here is a decision someone made, not drift.
 */
export function rentSettingsFingerprint(s: SorobanRentSettings): string {
  return [
    s.feeDiskReadLedgerEntry,
    s.feeDiskRead1KB,
    s.minPersistentTtlLedgers,
    s.maxEntryTtlLedgers,
    s.persistentRentRateDenominator,
    s.tempRentRateDenominator,
    s.feeWriteLedgerEntry,
    s.feeWrite1KB,
    s.sorobanStateTargetSizeBytes,
    s.rentFee1KBStateSizeLow,
    s.rentFee1KBStateSizeHigh,
    BigInt(s.stateRentFeeGrowthFactor),
  ]
    .map(String)
    .join(':');
}
