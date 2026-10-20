// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { I128_MAX } from '@ujira/core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ALLOWED_BY,
  DEPOSIT_STATUSES,
  LEG_STATUSES,
  MANDATE_INSTANCE_STATUSES,
  MANDATE_STATUSES,
  PAYOUT_METHODS,
  PAYOUT_STATUSES,
  RECIPIENT_MODES,
} from '../enums.js';
import { checkFixtures } from './check.js';
import {
  EDGE_NAMES,
  toMandateListItem,
  toPayoutListItem,
  toReceiptListItem,
  SYNTHETIC,
  EDGE_PAYOUT_COUNT,
  LOW_BALANCE_CASES,
  edgeFixtures,
  generateFixtures,
} from './index.js';
import type { FixtureSet } from './index.js';

// Any character from the Arabic or Hebrew blocks makes a name right to left.
const RTL = /[\u0590-\u05FF\u0600-\u06FF]/;

// Building and parsing 10,000 payouts takes well under a second alone, but
// the whole repository's suites run at once, so these get headroom.
const SCALE_TIMEOUT = 60_000;

describe('edge fixtures', () => {
  let set: FixtureSet;
  beforeAll(() => {
    set = edgeFixtures();
  }, SCALE_TIMEOUT);

  it(
    'the edge set contains every status, a right-to-left name, several dollar currencies and 10,000 payouts',
    () => {
      expect(set.payouts).toHaveLength(EDGE_PAYOUT_COUNT);
      expect(EDGE_PAYOUT_COUNT).toBe(10_000);

      expect(new Set(set.payouts.map((p) => p.status))).toEqual(new Set(PAYOUT_STATUSES));
      expect(new Set(set.payouts.map((p) => p.method))).toEqual(new Set(PAYOUT_METHODS));
      expect(new Set(set.payouts.flatMap((p) => p.legs.map((l) => l.status)))).toEqual(
        new Set(LEG_STATUSES),
      );
      expect(
        new Set(set.payouts.flatMap((p) => (p.allowedBy === null ? [] : [p.allowedBy]))),
      ).toEqual(new Set(ALLOWED_BY));
      expect(new Set(set.mandates.map((m) => m.status))).toEqual(new Set(MANDATE_STATUSES));
      expect(new Set(set.mandates.map((m) => m.recipientMode))).toEqual(new Set(RECIPIENT_MODES));
      expect(new Set(set.mandates.flatMap((m) => m.instances.map((i) => i.status)))).toEqual(
        new Set(MANDATE_INSTANCE_STATUSES),
      );
      expect(new Set(set.deposits.map((d) => d.status))).toEqual(new Set(DEPOSIT_STATUSES));

      const names = set.payouts.map((p) => p.recipient.displayName);
      expect(names.some((n) => RTL.test(n))).toBe(true);
      expect(names).toContain(EDGE_NAMES.long);
      expect(EDGE_NAMES.long.length).toBeGreaterThan(100);

      // One principal paying in more than one dollar currency.
      const first = set.tenants[0];
      const dollars = new Set(
        set.payouts
          .filter((p) => p.principalId === first?.principalId)
          .map((p) => p.requested.currency)
          .filter((c) => ['USD', 'COP', 'MXN'].includes(c)),
      );
      expect(dollars.size).toBeGreaterThanOrEqual(3);

      // Zero and maximum amounts.
      const amounts = [
        ...set.payouts.flatMap((p) => [
          p.requested.amount,
          ...(p.charges === null ? [] : [p.charges.take.amount]),
        ]),
        ...set.mandates.flatMap((m) =>
          m.instances.flatMap((i) => [i.budget.total.amount, i.budget.used.amount]),
        ),
        ...set.deposits.map((d) => d.amount.amount),
      ];
      expect(amounts).toContain('0');
      expect(amounts).toContain(I128_MAX.toString());

      expect(checkFixtures(set)).toEqual([]);
    },
    SCALE_TIMEOUT,
  );

  it('local-currency recipients never see the token, the network or a hash', () => {
    const local = set.recipientReceipts.flatMap((r) =>
      r.legs.filter((l) => l.method !== 'stellar_wallet'),
    );
    expect(local.length).toBeGreaterThan(0);
    for (const leg of local) {
      const text = JSON.stringify(leg);
      expect(text).not.toMatch(/USDC|stellar|txHash|[0-9a-f]{64}/i);
    }
    const wallet = set.recipientReceipts.flatMap((r) =>
      r.legs.filter((l) => l.method === 'stellar_wallet'),
    );
    expect(wallet.length).toBeGreaterThan(0);
    expect(JSON.stringify(wallet[0])).toMatch(/USDC/);
  });

  it('covers both low-balance rules firing, each alone, the short-history fallback and neither', () => {
    for (const fixtures of [set, generateFixtures({ seed: 7 })]) {
      const fired = firedByCase(fixtures);
      expect([...fired.keys()].sort()).toEqual([...LOW_BALANCE_CASES].sort());
      expect(fired.get('both')).toEqual(['runway', 'fixed']);
      expect(fired.get('runway')).toEqual(['runway']);
      expect(fired.get('fixed')).toEqual(['fixed']);
      expect(fired.get('fallback')).toEqual(['runway_fallback']);
      expect(fired.get('none')).toEqual([]);
    }
    // Every mandate starts from the default unless it set a fixed amount.
    expect(
      set.mandates.some((m) => m.lowBalance.runwayDays === 7 && m.lowBalance.fixed === null),
    ).toBe(true);
  });

  it('both payer name settings appear on recipient receipts', () => {
    const named = new Set(set.recipientReceipts.map((r) => r.payerDisplayName === null));
    expect(named).toEqual(new Set([true, false]));
  });

  it('covers a pending payout, an expired instance still holding committed funds, and approvals past the requirement', () => {
    const accounts = set.funding.flatMap((f) => f.accounts);

    // A payout awaiting approval holds part of the balance back.
    const pending = accounts.filter((a) => BigInt(a.balance.pending.amount) > 0n);
    expect(pending.length).toBeGreaterThan(0);
    for (const a of pending) {
      const active = !['expired', 'revoked'].includes(a.status);
      if (active) {
        const free =
          BigInt(a.balance.total.amount) -
          BigInt(a.balance.pending.amount) -
          BigInt(a.balance.committed.amount);
        expect(BigInt(a.balance.available.amount)).toBe(free > 0n ? free : 0n);
      }
    }

    // Expired but not revoked: the whole balance reads as available even
    // though funds are still committed to approved payouts.
    const expired = accounts.filter(
      (a) => a.status === 'expired' && BigInt(a.balance.committed.amount) > 0n,
    );
    expect(expired.length).toBeGreaterThan(0);
    for (const a of expired) expect(a.balance.available.amount).toBe(a.balance.total.amount);

    // An instance budget that uses all four parts.
    const budgets = set.mandates.flatMap((m) => m.instances.map((i) => i.budget));
    expect(budgets.some((b) => BigInt(b.pending.amount) > 0n)).toBe(true);
    for (const b of budgets) {
      const parts =
        BigInt(b.used.amount) +
        BigInt(b.pending.amount) +
        BigInt(b.committed.amount) +
        BigInt(b.remaining.amount);
      expect(parts).toBe(BigInt(b.total.amount));
    }

    // More approvals than the requirement, after the principal lowered it.
    expect(set.payouts.some((p) => p.approvals.given > p.approvals.required)).toBe(true);
  });

  it('shows a recipient which receipt a correction replaced', () => {
    const corrected = set.recipientReceipts.filter((r) => r.revision > 1);
    expect(corrected.length).toBeGreaterThan(0);
    for (const r of corrected) expect(r.supersedes).toMatch(/^R-[0-9A-Z]{12}$/);
    expect(set.recipientReceipts.some((r) => r.revision === 1 && r.supersedes === null)).toBe(true);
  });

  it('matches every edge name with the synthetic name pattern', () => {
    // Without this the pattern could name a script it never matches, because
    // a look-alike letter from another alphabet reads the same.
    for (const [kind, name] of Object.entries(EDGE_NAMES)) {
      expect(SYNTHETIC.recipientName.test(name), kind).toBe(true);
    }
    expect(SYNTHETIC.recipientName.test('Jane Smith')).toBe(false);
  });

  it('fixture data looks synthetic: no realistic addresses or hashes', () => {
    for (const m of set.mandates) {
      for (const role of m.instances.flatMap((i) => i.roles)) {
        expect(role.address).toMatch(SYNTHETIC.address);
      }
    }
    for (const d of set.deposits) {
      expect(d.txHash).toMatch(SYNTHETIC.hash);
      expect(d.fromAddress).toMatch(SYNTHETIC.address);
    }
  });

  // A future fixture must not drift into looking real, so every synthetic
  // value comes from one place and this walks the whole set against it.
  it('builds every address, hash, name and reference from the synthetic patterns', () => {
    const problems: string[] = [];
    const check = (where: string, value: unknown, pattern: RegExp): void => {
      if (typeof value === 'string' && !pattern.test(value)) problems.push(`${where}: ${value}`);
    };
    for (const m of set.mandates) {
      check('mandate.name', m.name, SYNTHETIC.mandateName);
      for (const i of m.instances) {
        check('instance.fundingAddress', i.fundingAddress, SYNTHETIC.address);
        for (const role of i.roles) check('role.address', role.address, SYNTHETIC.address);
      }
    }
    for (const p of set.payouts) {
      check('payout.recipientName', p.recipient.displayName, SYNTHETIC.recipientName);
      check('payout.taskId', p.taskId, SYNTHETIC.taskId);
      for (const leg of p.legs) {
        check('leg.txHash', leg.txHash, SYNTHETIC.hash);
        check('leg.maskedDestination', leg.maskedDestination, SYNTHETIC.maskedDestination);
        check('leg.anchorName', leg.anchorName, SYNTHETIC.anchorName);
        check('leg.anchorTransactionId', leg.anchorTransactionId, SYNTHETIC.anchorTransactionId);
      }
      if (p.receipt !== null)
        check('payout.receiptNumber', p.receipt.receiptNumber, SYNTHETIC.receiptNumber);
    }
    for (const r of set.receipts) {
      check('receipt.number', r.receiptNumber, SYNTHETIC.receiptNumber);
      check('receipt.payer', r.payerDisplayName, SYNTHETIC.principalName);
      check('receipt.verifyUrl', r.verifyUrl, SYNTHETIC.url);
      for (const leg of r.legs) check('receipt.leg.txHash', leg.txHash, SYNTHETIC.hash);
    }
    for (const r of set.recipientReceipts) {
      check('recipientReceipt.verifyUrl', r.verifyUrl, SYNTHETIC.url);
      check('recipientReceipt.supersedes', r.supersedes, SYNTHETIC.receiptNumber);
      for (const leg of r.legs) {
        if (leg.method === 'stellar_wallet') {
          check('recipientLeg.txHash', leg.txHash, SYNTHETIC.hash);
          check('recipientLeg.explorerUrl', leg.explorerUrl, SYNTHETIC.url);
        } else {
          check('recipientLeg.anchorName', leg.anchorName, SYNTHETIC.anchorName);
        }
      }
    }
    for (const d of set.deposits) {
      check('deposit.txHash', d.txHash, SYNTHETIC.hash);
      check('deposit.fromAddress', d.fromAddress, SYNTHETIC.address);
    }
    expect(problems).toEqual([]);
  });

  // A projection must carry the detail's own values, not merely values of the
  // right shape. Both tenant ids are uuids, so swapping them type checks and
  // still parses; only comparing against the source catches that.
  it('projects list items from their detail without changing a value', () => {
    const rows = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
    const compare = (
      item: Record<string, unknown>,
      source: Record<string, unknown>,
      label: string,
      options: { skip?: readonly string[]; minFields: number },
    ): void => {
      const keys = Object.keys(item).filter((k) => !(options.skip ?? []).includes(k));
      // Guards against an empty or gutted projection passing the loop.
      expect(keys.length, `${label} field count`).toBeGreaterThanOrEqual(options.minFields);
      for (const key of keys) {
        expect(Object.hasOwn(source, key), `${label}.${key} exists on the detail`).toBe(true);
        expect(item[key], `${label}.${key}`).toEqual(source[key]);
      }
    };

    for (const detail of set.mandates.slice(0, 20)) {
      const item = toMandateListItem(detail);
      expect(item.principalId).toBe(detail.principalId);
      expect(item.projectId).toBe(detail.projectId);
      compare(rows(item), rows(detail), 'mandate', { skip: ['instances'], minFields: 8 });
      expect(item.instances).toHaveLength(detail.instances.length);
      item.instances.forEach((projected, i) => {
        const source = detail.instances[i];
        expect(source, `mandate.instances[${String(i)}]`).toBeDefined();
        compare(rows(projected), rows(source), `mandate.instances[${String(i)}]`, { minFields: 5 });
      });
    }

    for (const detail of set.payouts.slice(0, 50)) {
      const item = toPayoutListItem(detail);
      expect(item.principalId).toBe(detail.principalId);
      expect(item.projectId).toBe(detail.projectId);
      compare(rows(item), rows(detail), 'payout', { minFields: 16 });
    }

    for (const receipt of set.receipts.slice(0, 20)) {
      const item = toReceiptListItem(receipt);
      expect(item.principalId).toBe(receipt.principalId);
      expect(item.projectId).toBe(receipt.projectId);
      compare(rows(item), rows(receipt), 'receipt', { minFields: 10 });
    }
  });

  it('every tenant row belongs to one of the fixture tenants', () => {
    const scopes = new Set(set.tenants.map((t) => `${t.principalId}/${t.projectId}`));
    const rows = [
      ...set.mandates,
      ...set.payouts,
      ...set.receipts,
      ...set.deposits,
      ...set.approvals,
      ...set.funding,
    ];
    for (const row of rows) expect(scopes.has(`${row.principalId}/${row.projectId}`)).toBe(true);
    expect(new Set(set.tenants.map((t) => t.principalId)).size).toBe(2);
  });

  it('approvals are oldest first and deposits newest first', () => {
    const asked = set.approvals.map((a) => Date.parse(a.requestedAt));
    expect([...asked].sort((a, b) => a - b)).toEqual(asked);
    for (const f of set.funding) {
      const seen = f.deposits.items.map((d) => Date.parse(d.seenAt));
      expect([...seen].sort((a, b) => b - a)).toEqual(seen);
      expect(f.deposits.items.length).toBeLessThanOrEqual(50);
    }
  });
});

function firedByCase(fixtures: FixtureSet): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const account of fixtures.funding.flatMap((f) => f.accounts)) {
    const lowCase = fixtures.lowBalanceCases.get(account.mandateInstanceId);
    if (lowCase !== undefined && !out.has(lowCase)) out.set(lowCase, account.lowBalance.firedBy);
  }
  return out;
}
