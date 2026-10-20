// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { NETWORK_IDS as ADAPTER_NETWORK_IDS } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import { generateFixtures, toPayoutListItem } from './fixtures/index.js';
import {
  ApprovalItem,
  CountryPolicy,
  Deposit,
  FundingOverview,
  LowBalance,
  LowBalanceState,
  MandateDetail,
  NETWORK_IDS,
  PayoutDetail,
  PayoutListItem,
  PayoutListQuery,
  PrincipalReceipt,
  Problem,
  RecipientReceipt,
  buildProblem,
} from './index.js';

const set = generateFixtures({ seed: 11, payouts: 400, edge: true });

// A deep copy that can be edited without touching the shared fixtures.
const clone = <T>(value: T): T => structuredClone(value);

function first<T>(rows: readonly T[], match: (row: T) => boolean): T {
  const found = rows.find(match);
  if (found === undefined) throw new Error('fixture missing for this test');
  return clone(found);
}

describe('schema rules', () => {
  it('keeps the network list in step with the chain adapter', () => {
    expect([...NETWORK_IDS]).toEqual([...ADAPTER_NETWORK_IDS]);
  });

  it('refuses a payout whose charged amount is not settlement plus take', () => {
    const p = first(set.payouts, (x) => x.charges !== null && x.charges.take.amount !== '0');
    if (p.charges === null) throw new Error('unreachable');
    p.charges.charged = { ...p.charges.charged, amount: p.charges.settlement.amount };
    expect(PayoutDetail.safeParse(p).success).toBe(false);
  });

  it('refuses a take above the fee cap', () => {
    const p = first(set.payouts, (x) => x.charges !== null);
    if (p.charges === null) throw new Error('unreachable');
    p.charges.takeBps = 0;
    p.charges.take = { ...p.charges.take, amount: '1' };
    p.charges.charged = {
      ...p.charges.charged,
      amount: (BigInt(p.charges.settlement.amount) + 1n).toString(),
    };
    expect(PayoutDetail.safeParse(p).success).toBe(false);
  });

  it('refuses legs that do not add up to the settlement amount', () => {
    const p = first(set.payouts, (x) => x.legs.length > 0 && x.status === 'paid');
    const leg = p.legs[0];
    if (leg === undefined) throw new Error('unreachable');
    leg.amount = { ...leg.amount, amount: (BigInt(leg.amount.amount) + 1n).toString() };
    expect(PayoutDetail.safeParse(p).success).toBe(false);
  });

  it('ties status to its fields: blocked names a rule, paid has a receipt, allowed names its rule', () => {
    const blocked = first(set.payouts, (x) => x.status === 'blocked');
    blocked.blockedBy = null;
    expect(PayoutDetail.safeParse(blocked).success).toBe(false);

    const paid = first(set.payouts, (x) => x.status === 'paid');
    paid.receipt = null;
    expect(PayoutDetail.safeParse(paid).success).toBe(false);

    const allowed = first(set.payouts, (x) => x.status === 'approved');
    allowed.allowedBy = null;
    expect(PayoutDetail.safeParse(allowed).success).toBe(false);

    const rejected = first(set.payouts, (x) => x.status === 'rejected');
    rejected.allowedBy = 'allowlist_auto';
    expect(PayoutDetail.safeParse(rejected).success).toBe(false);

    const queued = toPayoutListItem(first(set.payouts, (x) => x.status === 'queued'));
    expect(PayoutListItem.safeParse({ ...queued, status: 'paid' }).success).toBe(false);
    expect(PayoutListItem.safeParse({ ...queued, status: 'shipped' }).success).toBe(false);
  });

  it('refuses a timeline out of order and a wallet leg with an anchor', () => {
    const p = first(set.payouts, (x) => x.timeline[3].at !== null);
    p.timeline[3].at = '2000-01-01T00:00:00.000Z';
    expect(PayoutDetail.safeParse(p).success).toBe(false);

    const w = first(set.payouts, (x) => x.legs.some((l) => l.method === 'stellar_wallet'));
    const leg = w.legs.find((l) => l.method === 'stellar_wallet');
    if (leg === undefined) throw new Error('unreachable');
    leg.anchorName = 'Fixture Anchor';
    expect(PayoutDetail.safeParse(w).success).toBe(false);
  });

  it('refuses extra fields anywhere in a response', () => {
    const p = first(set.payouts, () => true);
    expect(PayoutDetail.safeParse({ ...p, internalNote: 'x' }).success).toBe(false);
  });

  it('checks mandate budgets and country policies', () => {
    const m = first(set.mandates, (x) => x.instances.length > 0);
    const instance = m.instances[0];
    if (instance === undefined) throw new Error('unreachable');
    instance.budget.remaining = {
      ...instance.budget.remaining,
      amount: (BigInt(instance.budget.remaining.amount) + 1n).toString(),
    };
    expect(MandateDetail.safeParse(m).success).toBe(false);

    expect(CountryPolicy.safeParse({ mode: 'allow', countries: [] }).success).toBe(false);
    expect(CountryPolicy.safeParse({ mode: 'block', countries: [] }).success).toBe(true);
    expect(CountryPolicy.safeParse({ mode: 'allow', countries: ['NG', 'KE'] }).success).toBe(false);
    expect(CountryPolicy.safeParse({ mode: 'allow', countries: ['KE', 'KE'] }).success).toBe(false);
  });

  it('needs at least one low-balance rule and a state that agrees with itself', () => {
    expect(LowBalance.safeParse({ runwayDays: null, fixed: null }).success).toBe(false);
    expect(LowBalance.safeParse({ runwayDays: 7, fixed: null }).success).toBe(true);
    const base = {
      runwayDays: 7,
      fixed: null,
      triggered: true,
      firedBy: ['runway'],
      since: '2026-09-01T00:00:00.000Z',
    };
    expect(LowBalanceState.safeParse(base).success).toBe(true);
    expect(LowBalanceState.safeParse({ ...base, firedBy: ['fixed'] }).success).toBe(false);
    expect(LowBalanceState.safeParse({ ...base, firedBy: [] }).success).toBe(false);
    expect(LowBalanceState.safeParse({ ...base, firedBy: ['runway', 'runway'] }).success).toBe(
      false,
    );
    // The short-history fallback is the runway rule, so it never fires next to it.
    expect(LowBalanceState.safeParse({ ...base, firedBy: ['runway_fallback'] }).success).toBe(true);
    expect(
      LowBalanceState.safeParse({ ...base, firedBy: ['runway_fallback', 'runway'] }).success,
    ).toBe(false);
    expect(
      LowBalanceState.safeParse({
        ...base,
        runwayDays: null,
        fixed: null,
        firedBy: ['runway_fallback'],
      }).success,
    ).toBe(false);
    expect(LowBalanceState.safeParse({ ...base, since: null }).success).toBe(false);
    expect(
      LowBalanceState.safeParse({
        ...base,
        runwayDays: null,
        firedBy: [],
        triggered: false,
        since: null,
      }).success,
    ).toBe(false);
  });

  it('checks funding balances and deposits', () => {
    const f = first(set.funding, (x) => x.accounts.length > 0);
    const account = f.accounts[0];
    if (account === undefined) throw new Error('unreachable');
    account.balance.total = {
      ...account.balance.total,
      amount: (BigInt(account.balance.total.amount) + 1n).toString(),
    };
    expect(FundingOverview.safeParse(f).success).toBe(false);

    const d = first(set.deposits, (x) => x.status === 'seen');
    expect(Deposit.safeParse({ ...d, amount: { ...d.amount, amount: '0' } }).success).toBe(false);
    expect(Deposit.safeParse({ ...d, status: 'confirmed' }).success).toBe(false);
    expect(Deposit.safeParse({ ...d, status: 'reversed' }).success).toBe(false);
  });

  it('keeps a waiting approval waiting', () => {
    const a = first(set.approvals, () => true);
    expect(
      ApprovalItem.safeParse({
        ...a,
        approvals: { given: a.approvals.required, required: a.approvals.required },
      }).success,
    ).toBe(false);
    expect(ApprovalItem.safeParse({ ...a, expiresAt: a.requestedAt }).success).toBe(false);
  });

  it('keeps the recipient view free of commercial terms and ids', () => {
    const r = first(set.recipientReceipts, () => true);
    expect(
      RecipientReceipt.safeParse({ ...r, payoutId: '00000000-0000-4000-8000-000000000000' })
        .success,
    ).toBe(false);
    expect(RecipientReceipt.safeParse({ ...r, take: { amount: '1' } }).success).toBe(false);
    const local = first(set.recipientReceipts, (x) =>
      x.legs.some((l) => l.method !== 'stellar_wallet' && l.costs !== null),
    );
    const leg = local.legs.find((l) => l.method !== 'stellar_wallet');
    if (leg === undefined || leg.costs === null) throw new Error('unreachable');
    // The rate is read against the dollar, never the token.
    leg.costs.rate = { ...leg.costs.rate, base: 'USDC' };
    expect(RecipientReceipt.safeParse(local).success).toBe(false);
    const wallet = {
      method: 'bank',
      received: { amount: '1', asset: 'USDC', network: 'stellar:pubnet', scale: 7 },
    };
    expect(RecipientReceipt.safeParse({ ...r, legs: [wallet] }).success).toBe(false);
  });

  it('checks principal receipt totals and revisions', () => {
    const r = first(set.receipts, (x) => x.revision === 1);
    expect(PrincipalReceipt.safeParse({ ...r, supersedesReceiptId: r.id }).success).toBe(false);
    expect(
      PrincipalReceipt.safeParse({
        ...r,
        takeRefunded: { ...r.take, amount: (BigInt(r.take.amount) + 1n).toString() },
      }).success,
    ).toBe(false);
  });

  it('parses the payout filter and refuses inverted ranges', () => {
    const ok = PayoutListQuery.safeParse({
      status: 'paid,failed',
      corridor: 'NG,KE',
      amountCurrency: 'USD',
      amountMin: '100',
      amountMax: '5000',
      limit: '25',
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.status).toEqual(['paid', 'failed']);
      expect(ok.data.limit).toBe(25);
    }
    expect(PayoutListQuery.safeParse({ amountMin: '5' }).success).toBe(false);
    expect(
      PayoutListQuery.safeParse({ amountCurrency: 'USD', amountMin: '9', amountMax: '1' }).success,
    ).toBe(false);
    expect(
      PayoutListQuery.safeParse({
        createdFrom: '2026-09-02T00:00:00Z',
        createdTo: '2026-09-01T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(PayoutListQuery.safeParse({ status: 'paid,paid' }).success).toBe(false);
    expect(PayoutListQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(PayoutListQuery.safeParse({ limit: '201' }).success).toBe(false);
    expect(PayoutListQuery.safeParse({ amountMin: '1.5', amountCurrency: 'USD' }).success).toBe(
      false,
    );
  });

  it('builds problems that pass their own schema and refuses mismatched ones', () => {
    const p = buildProblem('NOT_FOUND', 'req_0123456789');
    expect(Problem.safeParse(p).success).toBe(true);
    expect(Problem.safeParse({ ...p, status: 400 }).success).toBe(false);
    expect(
      Problem.safeParse({ ...p, type: 'https://docs.ujira.co/errors/RATE_LIMITED' }).success,
    ).toBe(false);
    const filter = buildProblem('INVALID_FILTER', 'req_0123456789', {
      detail: 'x',
      errors: [{ field: 'status', code: 'invalid_value' }],
    });
    expect(Problem.safeParse(filter).success).toBe(true);
  });
});
