// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The rent model priced with the testnet settings recorded in
// testnet-rent-settings.json. Expected figures are worked by hand in the
// comments, so a change to the formula cannot pass by updating a snapshot.

import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import {
  RECORD_TTL_MARGIN_SECONDS as SPEC_RECORD_TTL_MARGIN_SECONDS,
  STELLAR_LEDGER_SECONDS as SPEC_STELLAR_LEDGER_SECONDS,
} from '../testing/spec.js';

import {
  MINIMUM_RENT_FEE_PER_1KB,
  rentFee,
  rentFeePer1KB,
  rentForChange,
  rentForSizeAndLedgers,
} from './rent-fees.js';
import {
  RECORD_TTL_MARGIN_SECONDS,
  STELLAR_LEDGER_SECONDS,
  instanceExtensionRent,
  payoutRecordRent,
  recordTtlLedgers,
  restoreFee,
  tombstoneRent,
} from './rent-model.js';
import type { RentPolicy } from './rent-model.js';
import { decodeRentSettings, rentSettingsFingerprint } from './rent-settings.js';
import type { SorobanRentSettings } from './rent-settings.js';
import { INSTANCE_TTL_EXTEND_LEDGERS } from './restore-policy.js';
import recorded from './testnet-rent-settings.json' with { type: 'json' };

const testnet = decodeRentSettings(
  'stellar:testnet',
  BigInt(recorded.latestLedger),
  recorded.entries,
);

const POLICY: RentPolicy = {
  recordTtlMarginSeconds: RECORD_TTL_MARGIN_SECONDS,
  shortestLedgerCloseSeconds: STELLAR_LEDGER_SECONDS,
  instanceTtlExtendLedgers: 535_680n,
};
const NOW = 1_800_000_000n;
const LEDGER = 6_000_000n;
// The TTL entry write every extension pays: 1250 per entry written, and
// 48 bytes at 437 per 1 KB, 20.48 rounded up to 21.
const TTL_WRITE = 1_271n;

describe('recorded testnet settings', () => {
  it('decode to the values the network reports', () => {
    expect(testnet).toMatchObject({
      network: 'stellar:testnet',
      ledger: 5_502_731n,
      maxEntryTtlLedgers: 3_110_400n,
      minPersistentTtlLedgers: 120_960n,
      persistentRentRateDenominator: 1_215n,
      tempRentRateDenominator: 2_430n,
      feeWriteLedgerEntry: 1_250n,
      feeWrite1KB: 437n,
      sorobanStateTargetSizeBytes: 7_000_000_000n,
      rentFee1KBStateSizeLow: -17_000n,
      rentFee1KBStateSizeHigh: 10_000n,
      stateRentFeeGrowthFactor: 5_000,
    });
    expect(testnet.averageStateSizeBytes).toBeGreaterThan(4_000_000_000n);
    expect(testnet.averageStateSizeBytes).toBeLessThan(5_000_000_000n);
  });

  it('refuses entries it cannot read, and settings with one missing', () => {
    const [cost, archival, window, ext] = recorded.entries;
    if (cost === undefined || archival === undefined || window === undefined || ext === undefined) {
      throw new Error('fixture incomplete');
    }
    const decode = (entries: string[]) => () => decodeRentSettings('stellar:testnet', 1n, entries);
    expect(decode([cost, archival, window])).toThrow(InvalidInputError);
    expect(decode([cost, cost, archival, window, ext])).toThrow(InvalidInputError);
    // Setting 14, which rent does not read.
    expect(decode([cost, archival, window, ext, 'AAAACAAAAA4AAAAD'])).toThrow(InvalidInputError);
    const truncated = Buffer.from(ext, 'base64').subarray(0, 14).toString('base64');
    expect(decode([cost, archival, window, truncated])).toThrow(InvalidInputError);
    const longer = Buffer.concat([Buffer.from(ext, 'base64'), Buffer.alloc(4)]).toString('base64');
    expect(decode([cost, archival, window, longer])).toThrow(InvalidInputError);
    const notConfig = Buffer.from(ext, 'base64');
    notConfig.writeUInt32BE(6, 0);
    expect(decode([cost, archival, window, notConfig.toString('base64')])).toThrow(
      InvalidInputError,
    );
  });

  it('fingerprint governance values only, not the ledger or the state size', () => {
    const moved = { ...testnet, ledger: testnet.ledger + 64n, averageStateSizeBytes: 1n };
    expect(rentSettingsFingerprint(moved)).toBe(rentSettingsFingerprint(testnet));
    const changed = { ...testnet, persistentRentRateDenominator: 2_430n };
    expect(rentSettingsFingerprint(changed)).not.toBe(rentSettingsFingerprint(testnet));
  });
});

describe('rent fees', () => {
  it('prices 1 KB at the floor while the state is below its target', () => {
    // (10000 - -17000) * 4.4e9 / 7e9 is about 17000, minus 17000: under the floor.
    expect(rentFeePer1KB(testnet)).toBe(MINIMUM_RENT_FEE_PER_1KB);
  });

  it('raises the price with the state size, faster past the target', () => {
    const at = (size: bigint): bigint => rentFeePer1KB({ ...testnet, averageStateSizeBytes: size });
    // At the target: 27000 + -17000.
    expect(at(7_000_000_000n)).toBe(10_000n);
    // 1e9 past it: 27000 * 8e9 / 7e9 rounded up, -17000, plus 27000 * 1e9 * 5000 / 7e9 rounded up.
    expect(at(8_000_000_000n)).toBe(30_858n - 17_000n + 19_285_715n);
  });

  it('charges size times price times ledgers over 1 KB times the rate denominator', () => {
    // 1024 bytes for 1215 ledgers at 1000 per 1 KB: exactly 1000.
    expect(rentForSizeAndLedgers(testnet, 1_024n, 1_215n, true)).toBe(1_000n);
    // Temporary entries rent at half the persistent rate on testnet.
    expect(rentForSizeAndLedgers(testnet, 1_024n, 2_430n, false)).toBe(1_000n);
    expect(rentForSizeAndLedgers(testnet, 0n, 1_215n, true)).toBe(0n);
    expect(rentForSizeAndLedgers(testnet, 1n, 1n, true)).toBe(1n);
  });

  it('charges a grown entry for the ledgers it had already paid', () => {
    // 100 more bytes over the 10 ledgers left: 1e6 / 1244160, rounded up to 1.
    const change = {
      persistent: true,
      oldSizeBytes: 100n,
      newSizeBytes: 200n,
      oldLiveUntilLedger: LEDGER + 9n,
      newLiveUntilLedger: LEDGER + 9n,
    };
    expect(rentForChange(testnet, change, LEDGER)).toBe(1n);
    // Nothing was extended, so no TTL entry is written.
    expect(rentFee(testnet, [change], LEDGER)).toBe(1n);
  });
});

describe('the rent policy', () => {
  it('cost per payout includes record rent at the configured TTL', () => {
    // A payout at the 30 day maximum lives 30 days, plus the 1 day margin:
    // 2,678,400 seconds at 5 seconds a ledger is 535,680 ledgers.
    const cost = payoutRecordRent({
      settings: testnet,
      policy: POLICY,
      currentLedger: LEDGER,
      nowSeconds: NOW,
      expiresAtSeconds: NOW + 2_592_000n,
      recordSizeBytes: 1_024n,
    });
    expect(cost.ttlLedgers).toBe(535_680n);
    // 1024 * 1000 * 535680 / (1024 * 1215) = 440,888.9, rounded up.
    expect(cost.recordRent).toEqual({
      network: 'stellar:testnet',
      asset: 'XLM',
      amount: 440_889n,
      scale: 7,
    });
    expect(cost.ttlWrite.amount).toBe(TTL_WRITE);
    expect(cost.total.amount).toBe(440_889n + TTL_WRITE);
  });

  it('never keeps a record for less than the network minimum or more than its maximum', () => {
    // An hour plus a day is 18,000 ledgers, under the 120,960 minimum.
    expect(recordTtlLedgers(testnet, POLICY, NOW, NOW + 3_600n)).toBe(120_960n);
    expect(recordTtlLedgers(testnet, POLICY, NOW, NOW - 10n)).toBe(120_960n);
    expect(recordTtlLedgers(testnet, POLICY, NOW, NOW + 100_000_000n)).toBe(3_110_400n);
    // A shorter close time means more ledgers for the same seconds.
    const fast = { ...POLICY, shortestLedgerCloseSeconds: 4n };
    expect(recordTtlLedgers(testnet, fast, NOW, NOW + 2_592_000n)).toBe(669_600n);
    const zero = { ...POLICY, shortestLedgerCloseSeconds: 0n };
    expect(recordTtlLedgers(testnet, zero, NOW, NOW + 2_592_000n)).toBe(2_678_400n);
  });

  it('prices a tombstone at zero, since it is smaller and never extended', () => {
    expect(
      tombstoneRent({
        settings: testnet,
        currentLedger: LEDGER,
        recordSizeBytes: 1_024n,
        tombstoneSizeBytes: 120n,
        liveUntilLedger: LEDGER + 1_000n,
      }).amount,
    ).toBe(0n);
  });

  it('prices a restore as the minimum TTL, the TTL write and the entry write', () => {
    // 1024 * 1000 * 120960 / (1024 * 1215) = 99,555.6, rounded up; then the
    // TTL write, and the entry written again: 1250 and 1024 bytes at 437 per 1 KB.
    const fee = restoreFee({ settings: testnet, currentLedger: LEDGER, entrySizeBytes: 1_024n });
    expect(fee.amount).toBe(99_556n + TTL_WRITE + 1_250n + 437n);
  });

  it('extends the instance and balance entry to the policy, and nothing already there', () => {
    const rent = instanceExtensionRent({
      settings: testnet,
      policy: POLICY,
      currentLedger: LEDGER,
      entries: [
        { sizeBytes: 2_000n, liveUntilLedger: LEDGER + 100n },
        { sizeBytes: 300n, liveUntilLedger: LEDGER + 1_000_000n },
      ],
    });
    // Only the first moves, from 100 ledgers ahead to 535,679 ahead.
    expect(rent.amount).toBe(rentForSizeAndLedgers(testnet, 2_000n, 535_579n, true) + TTL_WRITE);
    const none = instanceExtensionRent({
      settings: testnet,
      policy: POLICY,
      currentLedger: LEDGER,
      entries: [{ sizeBytes: 2_000n, liveUntilLedger: LEDGER + 1_000_000n }],
    });
    expect(none.amount).toBe(0n);
  });

  it('uses the spec values for the record margin and the ledger time', () => {
    expect(RECORD_TTL_MARGIN_SECONDS).toBe(SPEC_RECORD_TTL_MARGIN_SECONDS);
    expect(STELLAR_LEDGER_SECONDS).toBe(BigInt(SPEC_STELLAR_LEDGER_SECONDS));
  });

  // The adapter extends instances by this many ledgers, so this is the
  // extension the model has to price.
  it('prices the instance extension the Stellar adapter actually asks for', () => {
    expect(POLICY.instanceTtlExtendLedgers).toBe(BigInt(INSTANCE_TTL_EXTEND_LEDGERS));
  });

  it('prices with whatever the network says now, so mainnet and a governance change differ', () => {
    const dearer: SorobanRentSettings = { ...testnet, persistentRentRateDenominator: 607n };
    const input = {
      policy: POLICY,
      currentLedger: LEDGER,
      nowSeconds: NOW,
      expiresAtSeconds: NOW + 2_592_000n,
      recordSizeBytes: 1_024n,
    };
    const base = payoutRecordRent({ ...input, settings: testnet }).recordRent.amount;
    const doubled = payoutRecordRent({ ...input, settings: dearer }).recordRent.amount;
    expect(doubled).toBeGreaterThan(base * 2n - 2n);
  });
});
