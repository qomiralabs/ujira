// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for issuing receipts (issue.ts), against the fake chain adapter.
 *
 * issueReceipt builds revision 1 from the paid payout and the chain's receipt,
 * verifies it with adapter.verifyReceipt and stores it. Repeating it issues
 * nothing new. A receipt the chain does not confirm, or that disagrees with
 * the payout, is not stored: it is blocked and alerted. A correction is the
 * next revision, referencing the previous one by number and document hash,
 * with the previous one left as it was. Each tenant sees only its own receipts.
 */

import { formatReceiptRef } from '@ujira/chain-adapter';
import type {
  ChainAdapter,
  ReceiptRef,
  ReceiptVerification,
  TenantScope,
} from '@ujira/chain-adapter';
import {
  deployMandate,
  drive,
  fakeAdapterHarness,
  finalReceipt,
  payRequest,
} from '@ujira/chain-adapter/testing';
import { money, sum, toDecimalString, tokenAmount } from '@ujira/core';
import { describe, expect, it } from 'vitest';

import { documentSha256 } from './document.js';
import {
  ReceiptChainAbortedError,
  ReceiptChainTimeoutError,
  ReceiptInvalidError,
  ReceiptNotIssuedError,
  ReceiptNotPaidError,
  ReceiptTenantMismatchError,
  ReceiptUnverifiedError,
} from './errors.js';
import {
  RECEIPT_ISSUE_MAX_ATTEMPTS,
  RECEIPT_ISSUE_TASK,
  issueReceipt,
  issueReceiptCorrection,
  receiptIssueJobKey,
  receiptIssueTask,
  receiptNumberFor,
} from './issue.js';
import type {
  PaidPayout,
  ReceiptAlerts,
  ReceiptIssuePorts,
  ReceiptIssueStore,
  StoredReceipt,
} from './issue.js';

const PAYOUT = 'c3a1e7f2-9b4d-4e86-a2f5-7d3c1b9e0a64';
const OPTS = { correlationId: 'corr-1' };
const NOW = 1_793_520_000n;

/** An append only store, keyed the way the table's unique constraint is. */
function memoryStore(): ReceiptIssueStore & { readonly rows: StoredReceipt[] } {
  const rows: StoredReceipt[] = [];
  const mine = (scope: TenantScope, payoutId: string) =>
    rows.filter(
      (row) =>
        row.payoutId === payoutId &&
        row.receipt.principalId === scope.principalId &&
        row.receipt.projectId === scope.projectId,
    );
  return {
    rows,
    latest: (scope, payoutId) => Promise.resolve(mine(scope, payoutId).at(-1) ?? null),
    insert: (scope, stored) => {
      if (
        mine(scope, stored.payoutId).some((r) => r.receipt.revision === stored.receipt.revision)
      ) {
        return Promise.resolve('conflict');
      }
      rows.push(stored);
      return Promise.resolve('inserted');
    },
  };
}

interface Alert {
  readonly reason: string;
  readonly payoutId: string;
}

async function world(fee = 5000n) {
  const h = fakeAdapterHarness();
  const m = await deployMandate(h);
  const req = await payRequest(h, m, 'receipt', { total: 1_000_000n, fee });
  finalReceipt((await drive(h.adapter, req)).at(-1));
  const chain = h.adapter.chain;
  const usdc = (amount: bigint) => tokenAmount(amount, 'USDC', chain);
  const paid: PaidPayout = {
    scope: h.scope,
    id: PAYOUT,
    chainPayoutId: req.payoutId,
    taskId: 'annotation-batch-118',
    mandate: { id: '8f4e2b6a-1c3d-4a7e-9b5f-0d2c6e8a4f13', name: 'Contributors', ref: m.ref },
    recipientRef: 'a'.repeat(64),
    requested: money('10', 'USD'),
    total: usdc(1_000_000n),
    fee: { amount: usdc(fee), bps: 50 },
    legs: [
      {
        index: 0,
        method: 'stellar_wallet',
        destination: { masked: 'GBXQ...7KLM', tag: null },
        received: null,
        railFee: usdc(0n),
      },
    ],
  };
  const store = memoryStore();
  const alerts: Alert[] = [];
  const sink: ReceiptAlerts = {
    receiptBlocked: (e) => alerts.push({ reason: e.reason, payoutId: e.payoutId }),
  };
  const ports = (overrides: Partial<ReceiptIssuePorts> = {}): ReceiptIssuePorts => ({
    store,
    paidPayout: (scope, payoutId) =>
      Promise.resolve(
        scope.principalId === paid.scope.principalId && payoutId === PAYOUT ? paid : null,
      ),
    adapter: () => h.adapter,
    alerts: sink,
    clock: { nowSeconds: () => NOW },
    chainTimeoutMs: 5000,
    ...overrides,
  });
  return { h, m, req, paid, store, alerts, ports, usdc };
}

function verifying(
  adapter: ChainAdapter,
  answer: ReceiptVerification,
): Pick<ChainAdapter, 'receipt' | 'verifyReceipt'> {
  return {
    receipt: (req, opts) => adapter.receipt(req, opts),
    verifyReceipt: () => Promise.resolve(answer),
  };
}

function refundRef(network: ChainAdapter['network'], fill = 'a'): ReceiptRef {
  return formatReceiptRef({ network, txHash: fill.repeat(64), eventIndex: 0 });
}

describe('issueReceipt', () => {
  it('builds the receipt from the payout and the chain', async () => {
    const { h, store, ports } = await world();
    const outcome = await issueReceipt(ports(), h.scope, PAYOUT, OPTS);
    if (outcome.status !== 'issued') throw new Error('expected a receipt');
    const { receipt } = outcome.stored;
    expect(receipt).toMatchObject({
      principalId: h.scope.principalId,
      projectId: h.scope.projectId,
      revision: 1,
      supersedes: null,
      payoutId: PAYOUT,
      issuedAt: '2026-11-01T08:00:00.000Z',
      network: h.adapter.network,
      receiptNumber: receiptNumberFor(h.scope, PAYOUT, 1),
    });
    expect(receipt.receiptNumber).toMatch(/^R-[0-9A-Z]{12}$/);
    expect(toDecimalString(sum(receipt.legs.map((leg) => leg.amount)))).toBe('0.1000000');
    expect(toDecimalString(receipt.charged)).toBe('0.1005000');
    expect(outcome.stored.documentSha256).toBe(documentSha256(receipt));
    expect(store.rows).toHaveLength(1);
  });

  it('a repeated paid event issues one receipt', async () => {
    const { h, store, ports } = await world();
    const first = await issueReceipt(ports(), h.scope, PAYOUT, OPTS);
    const second = await issueReceipt(ports(), h.scope, PAYOUT, OPTS);
    expect(first.status).toBe('issued');
    expect(second.status).toBe('already_issued');
    expect(store.rows).toHaveLength(1);
  });

  it('two jobs racing issue one receipt', async () => {
    const { h, store, ports } = await world();
    const outcomes = await Promise.all([
      issueReceipt(ports(), h.scope, PAYOUT, OPTS),
      issueReceipt(ports(), h.scope, PAYOUT, OPTS),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['already_issued', 'issued']);
    expect(store.rows).toHaveLength(1);
  });

  it('verifyReceipt mismatch blocks issue and alerts', async () => {
    const { h, store, alerts, ports } = await world();
    const adapter = verifying(h.adapter, { ok: false, reason: 'mismatch' });
    expect(await issueReceipt(ports({ adapter: () => adapter }), h.scope, PAYOUT, OPTS)).toEqual({
      status: 'blocked',
      reason: 'mismatch',
    });
    expect(store.rows).toHaveLength(0);
    expect(alerts).toEqual([{ reason: 'mismatch', payoutId: PAYOUT }]);
  });

  it('a receipt that verifies but disagrees with the payout is not issued', async () => {
    const { h, paid, store, alerts, ports, usdc, m } = await world();
    const cases: PaidPayout[] = [
      { ...paid, total: usdc(1_000_001n) },
      { ...paid, chainPayoutId: `0x${'9'.repeat(64)}` as PaidPayout['chainPayoutId'] },
      {
        ...paid,
        mandate: {
          ...paid.mandate,
          ref: { ...m.ref, address: { ...m.ref.address, value: h.wallet('other').value } },
        },
      },
      { ...paid, legs: [] },
      {
        ...paid,
        legs: paid.legs.map((leg) => ({
          ...leg,
          destination: { masked: leg.destination.masked, tag: 7n },
        })),
      },
    ];
    // The adapter is asked about the real payout whichever record is under test.
    const real = await h.adapter.receipt(
      { scope: h.scope, mandate: m.ref, payoutId: paid.chainPayoutId },
      OPTS,
    );
    const adapter = {
      receipt: () => Promise.resolve(real),
      verifyReceipt: () => Promise.resolve({ ok: true as const, receipt: real }),
    };
    for (const record of cases) {
      const outcome = await issueReceipt(
        ports({ adapter: () => adapter, paidPayout: () => Promise.resolve(record) }),
        h.scope,
        PAYOUT,
        OPTS,
      );
      expect(outcome).toEqual({ status: 'blocked', reason: 'payout_disagrees' });
    }
    expect(store.rows).toHaveLength(0);
    expect(alerts).toHaveLength(cases.length);
  });

  it('refuses a payout that has not reached paid', async () => {
    const { h, ports } = await world();
    await expect(
      issueReceipt(ports({ paidPayout: () => Promise.resolve(null) }), h.scope, PAYOUT, OPTS),
    ).rejects.toBeInstanceOf(ReceiptNotPaidError);
  });

  it('passes adapter errors through for the job to apply their retry rules', async () => {
    const { h, ports } = await world();
    h.faults?.chainDown(true);
    const error: unknown = await issueReceipt(ports(), h.scope, PAYOUT, OPTS).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'CHAIN_UNAVAILABLE' });
  });

  it('stops waiting at the deadline and when the caller aborts', async () => {
    const { h, store, ports } = await world();
    const silent = {
      receipt: () => new Promise<never>(() => undefined),
      verifyReceipt: () => new Promise<never>(() => undefined),
    };
    await expect(
      issueReceipt(ports({ adapter: () => silent, chainTimeoutMs: 10 }), h.scope, PAYOUT, OPTS),
    ).rejects.toBeInstanceOf(ReceiptChainTimeoutError);
    await expect(
      issueReceipt(ports({ adapter: () => silent }), h.scope, PAYOUT, {
        ...OPTS,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(ReceiptChainAbortedError);
    expect(store.rows).toHaveLength(0);
  });
});

describe('tenant isolation', () => {
  const OTHER: TenantScope = {
    principalId: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
  } as TenantScope;

  it('a receipt is invisible to another tenant, on the same payout ID', async () => {
    const { h, store, ports } = await world();
    await issueReceipt(ports(), h.scope, PAYOUT, OPTS);
    expect(await store.latest(OTHER, PAYOUT)).toBeNull();
    await expect(issueReceipt(ports(), OTHER, PAYOUT, OPTS)).rejects.toBeInstanceOf(
      ReceiptNotPaidError,
    );
    await expect(
      issueReceiptCorrection(ports(), {
        scope: OTHER,
        payoutId: PAYOUT,
        supersedesRevision: 1,
        feeRefund: { amount: tokenAmount(1n, 'USDC', h.adapter.chain), receiptRef: 'x' },
      }),
    ).rejects.toBeInstanceOf(ReceiptNotIssuedError);
    expect(store.rows).toHaveLength(1);
    expect(receiptNumberFor(OTHER, PAYOUT, 1)).not.toBe(receiptNumberFor(h.scope, PAYOUT, 1));
  });

  it('refuses a port that answers for another tenant', async () => {
    const { h, store, ports, paid } = await world();
    await issueReceipt(ports(), h.scope, PAYOUT, OPTS);
    const [row] = store.rows;
    const leaky: ReceiptIssueStore = {
      latest: () => Promise.resolve(row ?? null),
      insert: () => Promise.resolve('inserted'),
    };
    await expect(issueReceipt(ports({ store: leaky }), OTHER, PAYOUT, OPTS)).rejects.toBeInstanceOf(
      ReceiptTenantMismatchError,
    );
    await expect(
      issueReceipt(
        ports({ store: memoryStore(), paidPayout: () => Promise.resolve(paid) }),
        OTHER,
        PAYOUT,
        OPTS,
      ),
    ).rejects.toBeInstanceOf(ReceiptTenantMismatchError);
  });
});

describe('issueReceiptCorrection', () => {
  it('a refund issues revision 2 and keeps revision 1', async () => {
    const { h, store, ports, usdc } = await world();
    const first = await issueReceipt(ports(), h.scope, PAYOUT, OPTS);
    if (first.status !== 'issued') throw new Error('expected a receipt');
    const before = JSON.stringify(first.stored.documentSha256);
    const ref = refundRef(h.adapter.network);
    const outcome = await issueReceiptCorrection(ports(), {
      scope: h.scope,
      payoutId: PAYOUT,
      supersedesRevision: 1,
      feeRefund: { amount: usdc(1000n), receiptRef: ref },
    });
    if (outcome.status !== 'issued') throw new Error('expected a correction');
    const { receipt } = outcome.stored;
    expect(receipt.revision).toBe(2);
    expect(receipt.supersedes).toEqual({
      receiptNumber: first.stored.receipt.receiptNumber,
      documentSha256: first.stored.documentSha256,
    });
    expect(receipt.receiptNumber).not.toBe(first.stored.receipt.receiptNumber);
    expect(receipt.feeRefunds.map((r) => r.receiptRef)).toEqual([ref]);
    expect(store.rows.map((r) => r.receipt.revision)).toEqual([1, 2]);
    expect(store.rows[0]?.receipt.feeRefunds).toEqual([]);
    expect(JSON.stringify(store.rows[0]?.documentSha256)).toBe(before);
    expect(documentSha256(store.rows[0]?.receipt ?? receipt)).toBe(first.stored.documentSha256);
  });

  it('is idempotent per payout and revision', async () => {
    const { h, store, ports, usdc } = await world();
    await issueReceipt(ports(), h.scope, PAYOUT, OPTS);
    const req = {
      scope: h.scope,
      payoutId: PAYOUT,
      supersedesRevision: 1,
      feeRefund: { amount: usdc(1000n), receiptRef: refundRef(h.adapter.network) },
    };
    expect((await issueReceiptCorrection(ports(), req)).status).toBe('issued');
    expect((await issueReceiptCorrection(ports(), req)).status).toBe('already_issued');
    expect(store.rows).toHaveLength(2);
    const third = await issueReceiptCorrection(ports(), {
      ...req,
      supersedesRevision: 2,
      feeRefund: { amount: usdc(500n), receiptRef: refundRef(h.adapter.network, 'b') },
    });
    if (third.status !== 'issued') throw new Error('expected a correction');
    expect(third.stored.receipt.revision).toBe(3);
    expect(third.stored.receipt.feeRefunds).toHaveLength(2);
  });

  it('two corrections racing issue one revision', async () => {
    const { h, store, ports, usdc } = await world();
    await issueReceipt(ports(), h.scope, PAYOUT, OPTS);
    const req = {
      scope: h.scope,
      payoutId: PAYOUT,
      supersedesRevision: 1,
      feeRefund: { amount: usdc(1000n), receiptRef: refundRef(h.adapter.network) },
    };
    const outcomes = await Promise.all([
      issueReceiptCorrection(ports(), req),
      issueReceiptCorrection(ports(), req),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['already_issued', 'issued']);
    expect(store.rows).toHaveLength(2);
  });

  it('needs the revision it corrects, and a refund the model accepts', async () => {
    const { h, ports, usdc } = await world();
    const req = {
      scope: h.scope,
      payoutId: PAYOUT,
      supersedesRevision: 1,
      feeRefund: { amount: usdc(1000n), receiptRef: refundRef(h.adapter.network) },
    };
    await expect(issueReceiptCorrection(ports(), req)).rejects.toBeInstanceOf(
      ReceiptNotIssuedError,
    );
    await issueReceipt(ports(), h.scope, PAYOUT, OPTS);
    await expect(
      issueReceiptCorrection(ports(), { ...req, supersedesRevision: 2 }),
    ).rejects.toBeInstanceOf(ReceiptNotIssuedError);
    await expect(
      issueReceiptCorrection(ports(), {
        ...req,
        feeRefund: { ...req.feeRefund, amount: usdc(5001n) },
      }),
    ).rejects.toBeInstanceOf(ReceiptInvalidError);
  });
});

describe('the receipt:issue job', () => {
  const helpers = { correlationId: 'job-1' };

  it('names one job per payout with bounded retries', () => {
    expect(RECEIPT_ISSUE_TASK).toBe('receipt:issue');
    expect(receiptIssueJobKey(PAYOUT)).toBe(`receipt:issue:${PAYOUT}`);
    expect(RECEIPT_ISSUE_MAX_ATTEMPTS).toBeGreaterThan(0);
  });

  it('issues from its payload', async () => {
    const { h, store, ports } = await world();
    await receiptIssueTask(ports())(
      { principalId: h.scope.principalId, projectId: h.scope.projectId, payoutId: PAYOUT },
      helpers,
    );
    expect(store.rows).toHaveLength(1);
  });

  it('refuses a malformed payload', async () => {
    const { ports } = await world();
    for (const payload of [
      null,
      { payoutId: PAYOUT },
      { principalId: 'x', projectId: 'y', payoutId: 'z' },
    ]) {
      await expect(receiptIssueTask(ports())(payload, helpers)).rejects.toBeInstanceOf(
        ReceiptUnverifiedError,
      );
    }
  });

  it('retries a block that may clear and finishes on one that cannot', async () => {
    const { h, alerts, ports } = await world();
    const payload = {
      principalId: h.scope.principalId,
      projectId: h.scope.projectId,
      payoutId: PAYOUT,
    };
    for (const reason of ['not_found', 'reorged'] as const) {
      const adapter = verifying(h.adapter, { ok: false, reason });
      await expect(
        receiptIssueTask(ports({ adapter: () => adapter }))(payload, helpers),
      ).rejects.toBeInstanceOf(ReceiptUnverifiedError);
    }
    for (const reason of ['mismatch', 'outside_rpc_retention'] as const) {
      const adapter = verifying(h.adapter, { ok: false, reason });
      await expect(
        receiptIssueTask(ports({ adapter: () => adapter }))(payload, helpers),
      ).resolves.toBeUndefined();
    }
    expect(alerts.map((a) => a.reason)).toEqual([
      'not_found',
      'reorged',
      'mismatch',
      'outside_rpc_retention',
    ]);
  });
});
