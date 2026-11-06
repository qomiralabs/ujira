// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for fee reconciliation (fee-reconcile.ts), CHAINOPS-FEE-001 and the underpayment
 * rule of CHAINOPS-FEE-002, with fees really moved on the fake chain where the chain is the
 * question.
 *
 * - An executed fee is compared with the take from the agreed terms and nothing else.
 *   What the outcome and shortfall are follows the table's own checks, on what arrived:
 *   below the expected fee is underpaid by what is missing, and anything else that is not
 *   an exact match is a mismatch. A fee the chain says it took and did not deliver is
 *   alerted whatever the outcome reads, and is never invoiced.
 * - The fee address balance change must equal the executed fees less known outflows.
 * - Underpaid fees are reported per principal and period, and settled by a new revision.
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import type { NetworkId, TenantScope, Uuid } from '@ujira/chain-adapter';
import { deployMandate, drive, fakeAdapterHarness, payRequest } from '@ujira/chain-adapter/testing';
import { MoneyError, feeCap, tokenAmount } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';

import {
  FeeNotUnderpaidError,
  FeeReconciliationNotFoundError,
  FeeReportForeignRowError,
  FeeResolutionConflictError,
  InvalidFeePeriodError,
  checkFeeAddressBalance,
  reconcileFee,
  resolveUnderpaidFee,
  runFeeReconciliation,
  underpaidFeeReport,
} from './index.js';
import type {
  FeeAlerts,
  FeeDivergenceAlert,
  FeeMismatchAlert,
  FeePage,
  FeeReconciliation,
  FeeReconciliationRow,
  FeeReconciliationStore,
  FeeTerms,
} from './index.js';

const usdc = (amount: bigint): TokenAmount => tokenAmount(amount, 'USDC', 'stellar');
// Only one token exists today, so no real amount can be in another unit yet.
const otherUnit = (amount: bigint) =>
  ({ ...usdc(amount), asset: 'EURC' }) as unknown as TokenAmount;
const TERMS: FeeTerms = { id: 'terms-1', rateBps: 90, basis: 'standard', validFrom: new Date(0) };
const MAX_BPS = 100;
const MARCH: { from: Date; to: Date } = {
  from: new Date('2026-03-01T00:00:00Z'),
  to: new Date('2026-04-01T00:00:00Z'),
};
const NETWORK = 'stellar:testnet' as NetworkId;
const OPTS = { correlationId: 'fee-reconcile' };

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as Uuid;
const TENANT: TenantScope = { principalId: uuid(1), projectId: uuid(2) };
const OTHER_PROJECT: TenantScope = { principalId: uuid(1), projectId: uuid(3) };
const STRANGER: TenantScope = { principalId: uuid(9), projectId: uuid(10) };

function rowOf(
  attemptId: string,
  reconciliation: FeeReconciliation,
  over: Partial<FeeReconciliationRow> = {},
): FeeReconciliationRow {
  return {
    ...reconciliation,
    scope: TENANT,
    attemptId,
    revision: 1,
    network: NETWORK,
    executedAt: new Date('2026-03-15T00:00:00Z'),
    resolution: { kind: 'none' },
    ...over,
  };
}

const underpaid = (attemptId: string, over: Partial<FeeReconciliationRow> = {}) =>
  rowOf(
    attemptId,
    reconcileFee({
      total: usdc(1_000_000n),
      terms: TERMS,
      maxFeeBps: MAX_BPS,
      onChain: usdc(1_000n),
      received: usdc(1_000n),
    }),
    over,
  );

const matched = (attemptId: string, over: Partial<FeeReconciliationRow> = {}) =>
  rowOf(
    attemptId,
    reconcileFee({
      total: usdc(1_000_000n),
      terms: TERMS,
      maxFeeBps: MAX_BPS,
      onChain: usdc(9_000n),
      received: usdc(9_000n),
    }),
    over,
  );

const mismatched = (attemptId: string, over: Partial<FeeReconciliationRow> = {}) =>
  rowOf(
    attemptId,
    reconcileFee({
      total: usdc(1_000_000n),
      terms: TERMS,
      maxFeeBps: MAX_BPS,
      onChain: usdc(9_100n),
      received: usdc(9_100n),
    }),
    over,
  );

// The chain says the full fee was taken, and less of it arrived.
const lostOnTheWay = (attemptId: string, over: Partial<FeeReconciliationRow> = {}) =>
  rowOf(
    attemptId,
    reconcileFee({
      total: usdc(1_000_000n),
      terms: TERMS,
      maxFeeBps: MAX_BPS,
      onChain: usdc(9_000n),
      received: usdc(8_000n),
    }),
    over,
  );

function memoryStore(initial: readonly FeeReconciliationRow[], pageSize?: number) {
  const revisions: FeeReconciliationRow[] = [...initial];
  const latestRows = (): FeeReconciliationRow[] => {
    const newest = new Map<string, FeeReconciliationRow>();
    for (const row of revisions) {
      const key = `${row.scope.principalId}/${row.scope.projectId}/${row.attemptId}`;
      const seen = newest.get(key);
      if (seen === undefined || seen.revision < row.revision) newest.set(key, row);
    }
    return [...newest.values()];
  };
  const inPeriod = (row: FeeReconciliationRow, period: { from: Date; to: Date }) =>
    row.executedAt >= period.from && row.executedAt < period.to;
  const paged = (
    rows: readonly FeeReconciliationRow[],
    page: { after: string | null; limit: number },
  ): FeePage => {
    const start = page.after === null ? 0 : Number(page.after);
    const size = pageSize ?? page.limit;
    const end = start + size;
    return { rows: rows.slice(start, end), next: end < rows.length ? String(end) : null };
  };
  const store: FeeReconciliationStore = {
    executed: (network, period, page) =>
      Promise.resolve(
        paged(
          latestRows().filter((row) => row.network === network && inPeriod(row, period)),
          page,
        ),
      ),
    underpaid: (principalId, period, page) =>
      Promise.resolve(
        paged(
          latestRows().filter(
            (row) =>
              row.scope.principalId === principalId &&
              row.outcome === 'underpaid' &&
              inPeriod(row, period),
          ),
          page,
        ),
      ),
    latest: (scope, attemptId) =>
      Promise.resolve(
        latestRows().find(
          (row) =>
            row.attemptId === attemptId &&
            row.scope.principalId === scope.principalId &&
            row.scope.projectId === scope.projectId,
        ) ?? null,
      ),
    appendRevision: (row) => {
      const taken = revisions.some(
        (r) =>
          r.attemptId === row.attemptId &&
          r.revision === row.revision &&
          r.scope.projectId === row.scope.projectId,
      );
      if (!taken) revisions.push(row);
      return Promise.resolve(!taken);
    },
    executedFeeTotal: (network, _asset, period) =>
      Promise.resolve(
        usdc(
          latestRows()
            .filter((row) => row.network === network && inPeriod(row, period))
            .reduce((sum, row) => sum + row.onChain.amount, 0n),
        ),
      ),
  };
  return { store, revisions };
}

function recordingAlerts() {
  const mismatches: FeeMismatchAlert[] = [];
  const divergences: FeeDivergenceAlert[] = [];
  const alerts: FeeAlerts = {
    mismatch: (alert) => {
      mismatches.push(alert);
      return Promise.resolve();
    },
    divergence: (alert) => {
      divergences.push(alert);
      return Promise.resolve();
    },
  };
  return { alerts, mismatches, divergences };
}

/** A real payment on the fake chain, and what its fee address actually gained. */
async function paidOnChain(label: string, total: bigint, fee: bigint) {
  const h = fakeAdapterHarness();
  const m = await deployMandate(h, { maxFeeBps: MAX_BPS, fund: 100_000_000n });
  const feeAddress = { network: h.adapter.network, value: h.world.net.feeAddress };
  const before = await h.balance(feeAddress);
  const request = await payRequest(h, m, label, { total, fee });
  expect((await drive(h.adapter, request)).at(-1)?.kind).toBe('final');
  return { h, request, received: usdc((await h.balance(feeAddress)) - before) };
}

describe('fee-reconcile, CHAINOPS-FEE-001', () => {
  it('fee below tier is flagged with the exact difference', async () => {
    const total = 1_000_000n;
    const { request, received } = await paidOnChain('low', total, 1_234n);

    const result = reconcileFee({
      total: request.total,
      terms: TERMS,
      maxFeeBps: MAX_BPS,
      onChain: request.fee,
      received,
    });

    expect(result.outcome).toBe('underpaid');
    expect(result.expected).toEqual(usdc(9_000n));
    expect(result.shortfall).toEqual(usdc(9_000n - 1_234n));
  });

  it('fee at tier is clean', async () => {
    const { request, received } = await paidOnChain('at-tier', 1_000_000n, 9_000n);

    const result = reconcileFee({
      total: request.total,
      terms: TERMS,
      maxFeeBps: MAX_BPS,
      onChain: request.fee,
      received,
    });

    expect(result.outcome).toBe('matched');
    expect(result.shortfall).toEqual(usdc(0n));
    const { alerts, mismatches } = recordingAlerts();
    const { store } = memoryStore([rowOf('a', result)]);
    await runFeeReconciliation({ network: NETWORK, period: MARCH, ...OPTS }, { store, alerts });
    expect(mismatches).toEqual([]);
  });

  it('balance change not equal to executed fees raises divergence', async () => {
    const { h, request } = await paidOnChain('balance', 1_000_000n, 9_000n);
    const feeAddress = { network: h.adapter.network, value: h.world.net.feeAddress };
    const closing = await h.balance(feeAddress);
    const fees = [
      matched('a', { onChain: request.fee, received: request.fee, network: h.adapter.network }),
    ];
    const { store } = memoryStore(fees);
    const movement = (closed: bigint) => ({
      movement: () =>
        Promise.resolve({
          opening: usdc(closing - 9_000n),
          closing: usdc(closed),
          knownOutflows: usdc(0n),
        }),
    });
    const input = { network: h.adapter.network, asset: 'USDC' as const, period: MARCH, ...OPTS };

    const quiet = recordingAlerts();
    expect(
      await checkFeeAddressBalance(input, {
        store,
        ledger: movement(closing),
        alerts: quiet.alerts,
      }),
    ).toEqual({ kind: 'clean' });
    expect(quiet.divergences).toEqual([]);

    // Money that no fee explains arrives at the address.
    await h.fund(feeAddress, 7n);
    const loud = recordingAlerts();
    const check = await checkFeeAddressBalance(input, {
      store,
      ledger: movement(await h.balance(feeAddress)),
      alerts: loud.alerts,
    });
    expect(check).toEqual({ kind: 'diverged', difference: 7n });
    expect(loud.divergences).toEqual([
      expect.objectContaining({
        severity: 'high',
        network: h.adapter.network,
        asset: 'USDC',
        difference: 7n,
      }),
    ]);
  });

  it('a principal-covers grossed-up payout reconciles the take on the grossed-up total only', async () => {
    // The recipient is due this, and the principal covers a network cost on top of it.
    const net = 1_000_000n;
    const coveredCost = 3_000n;
    const grossedUp = net + coveredCost;
    const take = feeCap(usdc(grossedUp), TERMS.rateBps).amount;
    expect(take).toBe(9_027n);

    const paid = await paidOnChain('grossed', grossedUp, take);
    const atGrossed = reconcileFee({
      total: paid.request.total,
      terms: TERMS,
      maxFeeBps: MAX_BPS,
      onChain: paid.request.fee,
      received: paid.received,
    });
    expect(atGrossed.outcome).toBe('matched');
    expect(atGrossed.expected.amount).toBe(take);

    // A fee on the net amount is short by the take on the cost, never by the cost.
    const onNet = feeCap(usdc(net), TERMS.rateBps).amount;
    const short = reconcileFee({
      total: usdc(grossedUp),
      terms: TERMS,
      maxFeeBps: MAX_BPS,
      onChain: usdc(onNet),
      received: usdc(onNet),
    });
    expect(short.outcome).toBe('underpaid');
    expect(short.shortfall).toEqual(usdc(27n));
  });
});

describe('reconcileFee', () => {
  it('calls a fee above the agreed one a mismatch, since the principal overpaid', () => {
    const over = reconcileFee({
      total: usdc(1_000_000n),
      terms: TERMS,
      maxFeeBps: MAX_BPS,
      onChain: usdc(9_001n),
      received: usdc(9_001n),
    });
    expect(over.outcome).toBe('mismatch');
    expect(over.shortfall).toEqual(usdc(0n));
  });

  it('counts a fee that did not arrive in full as short by what is missing', () => {
    expect(lostOnTheWay('a').outcome).toBe('underpaid');
    expect(lostOnTheWay('a').shortfall).toEqual(usdc(1_000n));
  });

  it('calls more arriving than the chain says it took a mismatch', () => {
    const odd = reconcileFee({
      total: usdc(1_000_000n),
      terms: TERMS,
      maxFeeBps: MAX_BPS,
      onChain: usdc(8_000n),
      received: usdc(9_000n),
    });
    expect(odd.outcome).toBe('mismatch');
    expect(odd.shortfall).toEqual(usdc(0n));
  });

  it("always gives what the table's checks would accept", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 20_000n }),
        fc.bigInt({ min: 0n, max: 20_000n }),
        (onChain, received) => {
          const result = reconcileFee({
            total: usdc(1_000_000n),
            terms: TERMS,
            maxFeeBps: MAX_BPS,
            onChain: usdc(onChain),
            received: usdc(received),
          });
          const expected = result.expected.amount;
          // fee_reconciliations_shortfall_is_missing and fee_reconciliations_outcome_follows.
          expect(result.shortfall.amount).toBe(received < expected ? expected - received : 0n);
          expect(result.outcome).toBe(
            expected === onChain && onChain === received
              ? 'matched'
              : received < expected
                ? 'underpaid'
                : 'mismatch',
          );
        },
      ),
    );
  });

  it('expects the lower of the terms and the mandate cap, and nothing at cost', () => {
    const capped = reconcileFee({
      total: usdc(1_000_000n),
      terms: TERMS,
      maxFeeBps: 10,
      onChain: usdc(1_000n),
      received: usdc(1_000n),
    });
    expect(capped.outcome).toBe('matched');
    const atCost = reconcileFee({
      total: usdc(1_000_000n),
      terms: { ...TERMS, basis: 'internal_at_cost' },
      maxFeeBps: MAX_BPS,
      onChain: usdc(0n),
      received: usdc(0n),
    });
    expect(atCost.outcome).toBe('matched');
  });

  it('always accounts for the whole expected fee when underpaid', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        fc.integer({ min: 0, max: 100 }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        (total, bps, paid) => {
          const result = reconcileFee({
            total: usdc(total),
            terms: { ...TERMS, rateBps: bps },
            maxFeeBps: MAX_BPS,
            onChain: usdc(paid),
            received: usdc(paid),
          });
          const expected = feeCap(usdc(total), bps).amount;
          expect(result.expected.amount).toBe(expected);
          if (paid < expected) {
            expect(result.outcome).toBe('underpaid');
            expect(result.shortfall.amount + paid).toBe(expected);
          } else {
            expect(result.shortfall.amount).toBe(0n);
          }
        },
      ),
    );
  });

  it('refuses to compare amounts in different units', () => {
    expect(() =>
      reconcileFee({
        total: usdc(1_000_000n),
        terms: TERMS,
        maxFeeBps: MAX_BPS,
        onChain: usdc(9_000n),
        received: otherUnit(9_000n),
      }),
    ).toThrow(MoneyError);
  });
});

describe('runFeeReconciliation', () => {
  it('alerts each mismatch at high severity, and counts every row across pages', async () => {
    const { store } = memoryStore(
      [matched('a'), underpaid('b'), mismatched('c'), matched('d'), matched('e')],
      2,
    );
    const { alerts, mismatches } = recordingAlerts();

    const summary = await runFeeReconciliation(
      { network: NETWORK, period: MARCH, ...OPTS },
      { store, alerts },
    );

    expect(summary).toEqual({ matched: 3, underpaid: 1, mismatch: 1 });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      severity: 'high',
      key: 'fee-mismatch:c:1',
      correlationId: OPTS.correlationId,
    });
  });

  it('alerts a fee the chain took and did not deliver, though it reads as underpaid', async () => {
    const { store } = memoryStore([lostOnTheWay('lost'), underpaid('short')]);
    const { alerts, mismatches } = recordingAlerts();

    const summary = await runFeeReconciliation(
      { network: NETWORK, period: MARCH, ...OPTS },
      { store, alerts },
    );

    expect(summary).toEqual({ matched: 0, underpaid: 2, mismatch: 0 });
    expect(mismatches.map((alert) => alert.row.attemptId)).toEqual(['lost']);
  });

  it('gives a rerun the same alert key, so nobody is paged twice', async () => {
    const { store } = memoryStore([mismatched('c')]);
    const { alerts, mismatches } = recordingAlerts();
    const input = { network: NETWORK, period: MARCH, ...OPTS };
    await runFeeReconciliation(input, { store, alerts });
    await runFeeReconciliation(input, { store, alerts });
    expect(mismatches.map((alert) => alert.key)).toEqual(['fee-mismatch:c:1', 'fee-mismatch:c:1']);
  });

  it('counts only inside the period, and only on that network', async () => {
    const { store } = memoryStore([
      matched('in'),
      matched('at-end', { executedAt: MARCH.to }),
      matched('at-start', { executedAt: MARCH.from }),
      matched('elsewhere', { network: 'stellar:pubnet' as NetworkId }),
    ]);
    const { alerts } = recordingAlerts();
    const summary = await runFeeReconciliation(
      { network: NETWORK, period: MARCH, ...OPTS },
      { store, alerts },
    );
    expect(summary.matched).toBe(2);
  });

  it('does not swallow a failed read', async () => {
    const { store } = memoryStore([]);
    const failure = new Error('database down');
    vi.spyOn(store, 'executed').mockRejectedValue(failure);
    const { alerts } = recordingAlerts();
    await expect(
      runFeeReconciliation({ network: NETWORK, period: MARCH, ...OPTS }, { store, alerts }),
    ).rejects.toBe(failure);
  });

  it('refuses a period that does not run forwards, and gives each read a deadline', async () => {
    const { store } = memoryStore([]);
    const spy = vi.spyOn(store, 'executed');
    const { alerts } = recordingAlerts();
    await expect(
      runFeeReconciliation(
        { network: NETWORK, period: { from: MARCH.to, to: MARCH.from }, ...OPTS },
        { store, alerts },
      ),
    ).rejects.toBeInstanceOf(InvalidFeePeriodError);
    expect(spy).not.toHaveBeenCalled();
    await runFeeReconciliation(
      { network: NETWORK, period: MARCH, ...OPTS },
      { store, alerts, timeoutMs: 5_000 },
    );
    expect(spy.mock.calls[0]?.[3].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('checkFeeAddressBalance', () => {
  const input = { network: NETWORK, asset: 'USDC' as const, period: MARCH, ...OPTS };

  it('does not call a fee refund a divergence, CHAINOPS-FEE-004', async () => {
    const { store } = memoryStore([matched('a')]);
    const { alerts, divergences } = recordingAlerts();
    const ledger = {
      movement: () =>
        Promise.resolve({
          opening: usdc(100n),
          closing: usdc(100n + 9_000n - 500n),
          knownOutflows: usdc(500n),
        }),
    };
    expect(await checkFeeAddressBalance(input, { store, ledger, alerts })).toEqual({
      kind: 'clean',
    });
    expect(divergences).toEqual([]);
  });

  it('reports a fee that never arrived as a negative difference', async () => {
    const { store } = memoryStore([matched('a')]);
    const { alerts, divergences } = recordingAlerts();
    const ledger = {
      movement: () =>
        Promise.resolve({ opening: usdc(0n), closing: usdc(8_000n), knownOutflows: usdc(0n) }),
    };
    expect(await checkFeeAddressBalance(input, { store, ledger, alerts })).toEqual({
      kind: 'diverged',
      difference: -1_000n,
    });
    expect(divergences[0]?.difference).toBe(-1_000n);
    expect(divergences[0]?.key).toContain(MARCH.from.toISOString());
  });

  it('refuses a movement in another unit rather than adding it up', async () => {
    const { store } = memoryStore([matched('a')]);
    const { alerts } = recordingAlerts();
    const other = otherUnit(9_000n);
    const ledger = {
      movement: () => Promise.resolve({ opening: other, closing: other, knownOutflows: other }),
    };
    await expect(checkFeeAddressBalance(input, { store, ledger, alerts })).rejects.toBeInstanceOf(
      MoneyError,
    );
  });
});

describe('underpaidFeeReport', () => {
  it('reports each underpaid fee of the principal across projects and pages', async () => {
    const { store } = memoryStore(
      [
        underpaid('a'),
        underpaid('b', { scope: OTHER_PROJECT }),
        underpaid('invoiced', { resolution: { kind: 'invoiced', invoiceRef: 'INV-1' } }),
        matched('clean'),
        underpaid('theirs', { scope: STRANGER }),
        underpaid('april', { executedAt: MARCH.to }),
      ],
      1,
    );

    const report = await underpaidFeeReport(
      { principalId: TENANT.principalId, period: MARCH },
      { store },
    );

    expect(report.items.map((row) => row.attemptId)).toEqual(['a', 'b', 'invoiced']);
    expect(report.open).toEqual([usdc(2n * (9_000n - 1_000n))]);
  });

  it('shows nothing owed when all of it is settled', async () => {
    const { store } = memoryStore([underpaid('a', { resolution: { kind: 'waived' } })]);
    const report = await underpaidFeeReport(
      { principalId: TENANT.principalId, period: MARCH },
      { store },
    );
    expect(report.items).toHaveLength(1);
    expect(report.open).toEqual([]);
  });

  it("never shows another principal's row, even when a store returns one", async () => {
    const { store } = memoryStore([]);
    vi.spyOn(store, 'underpaid').mockResolvedValue({
      rows: [underpaid('theirs', { scope: STRANGER })],
      next: null,
    });
    await expect(
      underpaidFeeReport({ principalId: TENANT.principalId, period: MARCH }, { store }),
    ).rejects.toBeInstanceOf(FeeReportForeignRowError);
  });

  it('refuses a backwards period', async () => {
    const { store } = memoryStore([]);
    await expect(
      underpaidFeeReport(
        { principalId: TENANT.principalId, period: { from: MARCH.to, to: MARCH.to } },
        { store },
      ),
    ).rejects.toBeInstanceOf(InvalidFeePeriodError);
  });
});

describe('resolveUnderpaidFee', () => {
  const invoiced = { kind: 'invoiced', invoiceRef: 'INV-1' } as const;

  it('writes a new revision and leaves the old one as it was', async () => {
    const original = underpaid('a');
    const { store, revisions } = memoryStore([original]);

    const row = await resolveUnderpaidFee(
      { scope: TENANT, attemptId: 'a', resolution: invoiced },
      { store },
    );

    expect(row).toMatchObject({ revision: 2, resolution: invoiced });
    expect(row.shortfall).toEqual(original.shortfall);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toEqual(original);
  });

  it('treats the same answer again as a retry and writes nothing', async () => {
    const { store, revisions } = memoryStore([underpaid('a')]);
    const input = { scope: TENANT, attemptId: 'a', resolution: invoiced };
    const first = await resolveUnderpaidFee(input, { store });
    expect(await resolveUnderpaidFee(input, { store })).toEqual(first);
    expect(revisions).toHaveLength(2);
  });

  it('refuses a different answer once it is settled', async () => {
    const { store } = memoryStore([underpaid('a')]);
    await resolveUnderpaidFee({ scope: TENANT, attemptId: 'a', resolution: invoiced }, { store });
    for (const resolution of [
      { kind: 'waived' },
      { kind: 'invoiced', invoiceRef: 'INV-2' },
    ] as const) {
      await expect(
        resolveUnderpaidFee({ scope: TENANT, attemptId: 'a', resolution }, { store }),
      ).rejects.toBeInstanceOf(FeeResolutionConflictError);
    }
  });

  it('settles a race: the same answer stands, and a different one is refused', async () => {
    const race = async (winner: FeeReconciliationRow['resolution']) => {
      const { store } = memoryStore([underpaid('a')]);
      const append = store.appendRevision.bind(store);
      vi.spyOn(store, 'appendRevision').mockImplementationOnce(async (row, opts) => {
        await append({ ...row, resolution: winner }, opts);
        return false;
      });
      return resolveUnderpaidFee(
        { scope: TENANT, attemptId: 'a', resolution: invoiced },
        { store },
      );
    };
    expect(await race(invoiced)).toMatchObject({ revision: 2, resolution: invoiced });
    await expect(race({ kind: 'waived' })).rejects.toBeInstanceOf(FeeResolutionConflictError);
  });

  it('refuses a lost race where nothing was actually written', async () => {
    const { store } = memoryStore([underpaid('a')]);
    vi.spyOn(store, 'appendRevision').mockResolvedValueOnce(false);
    await expect(
      resolveUnderpaidFee({ scope: TENANT, attemptId: 'a', resolution: invoiced }, { store }),
    ).rejects.toBeInstanceOf(FeeResolutionConflictError);
  });

  it('only settles an underpaid fee', async () => {
    const { store } = memoryStore([matched('fine'), mismatched('odd')]);
    for (const attemptId of ['fine', 'odd']) {
      await expect(
        resolveUnderpaidFee({ scope: TENANT, attemptId, resolution: invoiced }, { store }),
      ).rejects.toBeInstanceOf(FeeNotUnderpaidError);
    }
  });

  it('will not invoice a fee the chain says the principal already paid', async () => {
    const { store, revisions } = memoryStore([lostOnTheWay('lost')]);
    await expect(
      resolveUnderpaidFee({ scope: TENANT, attemptId: 'lost', resolution: invoiced }, { store }),
    ).rejects.toBeInstanceOf(FeeNotUnderpaidError);
    expect(revisions).toHaveLength(1);
  });

  it("cannot see or settle another tenant's fee", async () => {
    const { store, revisions } = memoryStore([underpaid('a')]);
    for (const scope of [STRANGER, OTHER_PROJECT]) {
      await expect(
        resolveUnderpaidFee({ scope, attemptId: 'a', resolution: invoiced }, { store }),
      ).rejects.toBeInstanceOf(FeeReconciliationNotFoundError);
    }
    expect(revisions).toHaveLength(1);
  });
});
