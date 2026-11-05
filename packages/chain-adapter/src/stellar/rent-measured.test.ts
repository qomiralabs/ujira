// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The rent model against what testnet really charged and simulated, from
// responses recorded in testnet-rent-measured.json. A landed transaction states
// the rent it paid, which is the strongest evidence there is, so those must
// match to the stroop. A simulation only states a total with a margin in it, so
// those carry a stated tolerance.

import { createHash } from 'node:crypto';

import { xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';

import {
  contractCodeRentSizeBytes,
  rentFee,
  rentFeePer1KB,
  rentForSizeAndLedgers,
} from './rent-fees.js';
import type { RentChange } from './rent-fees.js';
import { payoutRecordRent, restoreFee } from './rent-model.js';
import { decodeContractCodeEntry, decodeMemoryCosts, decodeRentSettings } from './rent-settings.js';
import recorded from './testnet-rent-measured.json' with { type: 'json' };

const settings = decodeRentSettings(
  'stellar:testnet',
  BigInt(recorded.settings.latestLedger),
  recorded.settings.entries,
);
const memoryCosts = decodeMemoryCosts(recorded.memoryCosts);

// What a contract data entry pays rent on is the whole ledger entry: its data
// with the last modified ledger and the extension around it.
const ENTRY_WRAPPER_BYTES = 8n;
// Simulations reserve 15% over the rent, and the unused part comes back.
const SIMULATED_RENT_MARGIN_PERCENT = 115n;
// What a footprint transaction pays for its own size and for running at all,
// which is not part of what any one entry costs.
const RESTORE_TX_OVERHEAD = 5_167n;
// How far a simulated extension may sit from the model, once the margin and the
// same transaction extending nothing are taken off. The stroops cover a small
// fixed part that is not rent; the share covers the ledger or so that can pass
// between reading the entry and simulating, since code costs hundreds of stroops
// a ledger.
const EXTENSION_TOLERANCE_STROOPS = 110n;
const EXTENSION_TOLERANCE_PER_MILLE = 1n;

// An entry whose TTL moved while its data did not, so its size was read apart.
interface TtlOnly {
  readonly entryHash: string;
  readonly code: boolean;
  readonly dataXdrBytes: number;
  readonly persistent?: boolean;
  readonly costInputs?: readonly number[];
}

interface Tracked {
  readonly persistent: boolean;
  readonly code: boolean;
  oldSizeBytes: bigint;
  newSizeBytes: bigint;
  oldLiveUntilLedger: bigint;
  newLiveUntilLedger: bigint;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function keyHashOf(data: xdr.LedgerEntryData): string | null {
  if (data.type === 'contractData') {
    const { contract, key, durability } = data.contractData;
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({ contract, key, durability }),
    );
    return sha256(ledgerKey.toXdr());
  }
  if (data.type === 'contractCode') {
    const ledgerKey = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: data.contractCode.hash }),
    );
    return sha256(ledgerKey.toXdr());
  }
  return null;
}

function entryOf(change: xdr.LedgerEntryChange): xdr.LedgerEntry | null {
  if (change.type === 'ledgerEntryState') return change.state;
  if (change.type === 'ledgerEntryCreated') return change.created;
  if (change.type === 'ledgerEntryUpdated') return change.updated;
  return null;
}

function rentSizeOf(entry: xdr.LedgerEntry): bigint {
  if (entry.data.type !== 'contractCode') return BigInt(entry.toXdr().length);
  return contractCodeRentSizeBytes(
    decodeContractCodeEntry(entry.data.toXdr('base64')),
    memoryCosts,
  );
}

type Landed = (typeof recorded.landed)[number];

// The TTLs seen so far, kept across transactions: an entry that grows without
// being extended states no TTL of its own, and pays on the one it already had.
function rentChangesOf(tx: Landed, liveUntil: Map<string, bigint>): RentChange[] {
  const entries = new Map<string, Tracked>();
  const track = (hash: string, persistent: boolean, size: bigint, code: boolean): Tracked => {
    const known = entries.get(hash);
    if (known !== undefined) return known;
    const fresh: Tracked = {
      persistent,
      code,
      oldSizeBytes: size,
      newSizeBytes: size,
      oldLiveUntilLedger: liveUntil.get(hash) ?? 0n,
      newLiveUntilLedger: liveUntil.get(hash) ?? 0n,
    };
    entries.set(hash, fresh);
    return fresh;
  };
  for (const only of tx.ttlOnly as readonly TtlOnly[]) {
    const size = only.code
      ? contractCodeRentSizeBytes(
          { dataXdrBytes: BigInt(only.dataXdrBytes), costInputs: only.costInputs ?? [] },
          memoryCosts,
        )
      : BigInt(only.dataXdrBytes) + ENTRY_WRAPPER_BYTES;
    track(only.entryHash, only.code || only.persistent === true, size, only.code);
  }
  const changes = tx.changes.map((change) => xdr.LedgerEntryChange.fromXdr(change, 'base64'));
  const ttlChanges = changes.flatMap((change) => {
    const entry = entryOf(change);
    return entry?.data.type === 'ttl' ? [{ type: change.type, ttl: entry.data.ttl }] : [];
  });
  for (const change of changes) {
    const entry = entryOf(change);
    if (entry === null) continue;
    const hash = keyHashOf(entry.data);
    if (hash === null) continue;
    const persistent =
      entry.data.type !== 'contractData' ||
      entry.data.contractData.durability.name === 'persistent';
    const size = rentSizeOf(entry);
    const code = entry.data.type === 'contractCode';
    if (change.type === 'ledgerEntryCreated') {
      const tracked = track(hash, persistent, 0n, code);
      tracked.oldSizeBytes = 0n;
      tracked.newSizeBytes = size;
    } else if (change.type === 'ledgerEntryState') {
      track(hash, persistent, size, code).oldSizeBytes = size;
    } else {
      track(hash, persistent, size, code).newSizeBytes = size;
    }
  }
  for (const { type, ttl } of ttlChanges) {
    const hash = hex(ttl.keyHash.toXdr());
    const tracked = entries.get(hash);
    if (tracked === undefined) continue;
    const live = BigInt(ttl.liveUntilLedgerSeq);
    if (type === 'ledgerEntryState') tracked.oldLiveUntilLedger = live;
    else tracked.newLiveUntilLedger = live;
    liveUntil.set(hash, tracked.newLiveUntilLedger);
  }
  return [...entries.values()];
}

function replayLanded(): { name: string; charged: bigint; model: bigint }[] {
  const liveUntil = new Map<string, bigint>();
  return recorded.landed.map((tx) => ({
    name: tx.name,
    charged: BigInt(tx.rentFeeCharged),
    model: rentFee(settings, rentChangesOf(tx, liveUntil), BigInt(tx.ledger)),
  }));
}

describe('the recording', () => {
  it('is priced at the floor, so the state size in it does not decide the result', () => {
    expect(recorded.protocolVersion).toBe(30);
    expect(rentFeePer1KB(settings)).toBe(1_000n);
  });
});

describe('the rent the network charged', () => {
  it.each(replayLanded())('matches to the stroop: $name', ({ charged, model }) => {
    expect(model).toBe(charged);
  });

  it('prices the measured payout record through the rent policy', () => {
    const [request] = recorded.landed;
    if (request === undefined) throw new Error('fixture incomplete');
    const cost = payoutRecordRent({
      settings,
      policy: {
        recordTtlMarginSeconds: 0n,
        shortestLedgerCloseSeconds: 5n,
        instanceTtlExtendLedgers: 535_680n,
      },
      currentLedger: BigInt(request.ledger),
      nowSeconds: 0n,
      // Short enough that the record takes the network's minimum TTL.
      expiresAtSeconds: 0n,
      recordSizeBytes: 732n,
    });
    expect(cost.ttlLedgers).toBe(120_960n);
    expect(cost.total.amount).toBe(BigInt(request.rentFeeCharged));
    expect(cost.total.amount).toBe(72_438n);
  });

  it('puts the real record for 31 days at 0.0316 XLM, under the 1 KB estimate of 0.0442', () => {
    const at = (recordSizeBytes: bigint): bigint =>
      payoutRecordRent({
        settings,
        policy: {
          recordTtlMarginSeconds: 86_400n,
          shortestLedgerCloseSeconds: 5n,
          instanceTtlExtendLedgers: 535_680n,
        },
        currentLedger: 6_000_000n,
        nowSeconds: 0n,
        expiresAtSeconds: 2_592_000n,
        recordSizeBytes,
      }).total.amount;
    // 732 * 1000 * 535680 / (1024 * 1215) = 315,166.4, rounded up, and the TTL write.
    expect(at(732n)).toBe(315_167n + 1_271n);
    expect(at(1_024n)).toBe(442_160n);
  });
});

describe('what a contract code entry pays rent on', () => {
  it('costs about 6.5 times what its bytes alone would pay, for the mandate code', () => {
    const { dataXdrBytes, costInputs } = recorded.mandateCode;
    const size = contractCodeRentSizeBytes(
      { dataXdrBytes: BigInt(dataXdrBytes), costInputs },
      memoryCosts,
    );
    expect(size).toBe(1_293_419n);
    const asCode = rentForSizeAndLedgers(settings, size, 535_680n, true, true);
    const asData = rentForSizeAndLedgers(settings, BigInt(dataXdrBytes) + 8n, 535_680n, true);
    // 18.56 XLM for 31 days, against the 2.86 its bytes would suggest.
    expect(asCode).toBe(185_629_579n);
    expect((asCode * 10n) / asData).toBe(64n);
  });

  it('reads the cost inputs from a real code entry', () => {
    const upload = recorded.landed.at(-1);
    const created = upload?.changes
      .map((change) => xdr.LedgerEntryChange.fromXdr(change, 'base64'))
      .map(entryOf)
      .find((entry) => entry?.data.type === 'contractCode');
    if (created == null) throw new Error('fixture incomplete');
    expect(decodeContractCodeEntry(created.data.toXdr('base64'))).toEqual({
      dataXdrBytes: 6_892n,
      costInputs: [1_647, 24, 2, 0, 17, 5, 0, 27, 7, 2_994],
    });
  });

  it('refuses a code entry with no cost inputs, and data that is not code', () => {
    const noInputs = Buffer.alloc(8);
    noInputs.writeUInt32BE(7, 0);
    expect(() => decodeContractCodeEntry(noInputs.toString('base64'))).toThrow(InvalidInputError);
    expect(() => decodeContractCodeEntry(recorded.memoryCosts)).toThrow(InvalidInputError);
  });

  it('refuses any other setting as the memory cost table', () => {
    const [first] = recorded.settings.entries;
    if (first === undefined) throw new Error('fixture incomplete');
    expect(() => decodeMemoryCosts(first)).toThrow(InvalidInputError);
  });

  it('refuses inputs of the wrong length rather than pricing them', () => {
    expect(() =>
      contractCodeRentSizeBytes({ dataXdrBytes: 1n, costInputs: [1, 2] }, memoryCosts),
    ).toThrow(InvalidInputError);
  });

  it('refuses a memory cost table too short to hold the parse costs', () => {
    expect(() =>
      contractCodeRentSizeBytes(
        { dataXdrBytes: 1n, costInputs: recorded.mandateCode.costInputs },
        memoryCosts.slice(0, 5),
      ),
    ).toThrow(InvalidInputError);
  });
});

describe('simulated extensions', () => {
  const samples = recorded.simulated;
  const rentSizeOfSample = (sample: (typeof samples)[number]): bigint =>
    sample.isCode
      ? contractCodeRentSizeBytes(
          {
            dataXdrBytes: BigInt(sample.dataXdrBytes),
            costInputs: recorded.mandateCode.costInputs,
          },
          memoryCosts,
        )
      : BigInt(sample.dataXdrBytes) + ENTRY_WRAPPER_BYTES;

  it.each(samples.filter((s) => s.latestLedger + s.extendTo > s.liveUntilLedgerSeq))(
    'matches with the margin: $name to $extendTo',
    (sample) => {
      const noop = samples.find((s) => s.name === sample.name && s.extendTo === 300_000);
      if (noop === undefined) throw new Error('fixture incomplete');
      const ledger = BigInt(sample.latestLedger);
      const size = rentSizeOfSample(sample);
      const rent = rentFee(
        settings,
        [
          {
            persistent: true,
            code: sample.isCode,
            oldSizeBytes: size,
            newSizeBytes: size,
            oldLiveUntilLedger: BigInt(sample.liveUntilLedgerSeq),
            newLiveUntilLedger: ledger + BigInt(sample.extendTo),
          },
        ],
        ledger,
      );
      const reserved = (rent * SIMULATED_RENT_MARGIN_PERCENT) / 100n;
      const measured = BigInt(sample.minResourceFee) - BigInt(noop.minResourceFee);
      const gap = measured > reserved ? measured - reserved : reserved - measured;
      const allowed = EXTENSION_TOLERANCE_STROOPS + (rent * EXTENSION_TOLERANCE_PER_MILLE) / 1_000n;
      expect(gap).toBeLessThanOrEqual(allowed);
    },
  );

  it('charges nothing for rent when the entry already lives that long', () => {
    const noops = samples.filter((s) => s.latestLedger + s.extendTo <= s.liveUntilLedgerSeq);
    expect(noops.length).toBeGreaterThan(0);
    expect(new Set(noops.map((s) => s.minResourceFee)).size).toBe(1);
  });
});

describe('simulated restores', () => {
  it.each(recorded.restores)('matches for $dataXdrBytes bytes of data', (sample) => {
    const size = BigInt(sample.dataXdrBytes) + ENTRY_WRAPPER_BYTES;
    const ledger = BigInt(sample.latestLedger);
    const rent = rentFee(
      settings,
      [
        {
          persistent: true,
          oldSizeBytes: 0n,
          newSizeBytes: size,
          oldLiveUntilLedger: 0n,
          newLiveUntilLedger: ledger + settings.minPersistentTtlLedgers - 1n,
        },
      ],
      ledger,
    );
    const fee = restoreFee({ settings, currentLedger: ledger, entrySizeBytes: size }).amount;
    const margin = (rent * (SIMULATED_RENT_MARGIN_PERCENT - 100n)) / 100n;
    const gap = BigInt(sample.minResourceFee) - fee - margin - RESTORE_TX_OVERHEAD;
    expect(gap).toBe(0n);
  });
});
