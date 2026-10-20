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

  it('fixture data looks synthetic: no realistic addresses or hashes', () => {
    for (const m of set.mandates) {
      for (const role of m.instances.flatMap((i) => i.roles))
        expect(role.address).toContain('FIXTURE');
    }
    for (const d of set.deposits) {
      expect(d.txHash.startsWith('0000000000000000')).toBe(true);
      expect(d.fromAddress).toContain('FIXTURE');
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
