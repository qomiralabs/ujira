// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// safeParse is a caller's promise that bad input comes back as a result, not
// as an exception. A refinement that reads a value the inner schema has
// already rejected breaks that promise, and because these schemas validate
// client supplied query text, breaking it turns a documented 400 into a 500
// carrying an exception. Every schema that converts text to a number is
// checked here against input that cannot be converted.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseQuery } from './contract.js';
import { generateFixtures } from './fixtures/index.js';
import { FundingAccount } from './funding.js';
import { MandateDetail } from './mandates.js';
import { Money, TokenAmount } from './money.js';
import { PayoutDetail, PayoutListQuery } from './payouts.js';
import { ApprovalItem } from './approvals.js';
import { PrincipalReceipt } from './receipts.js';

// Text a client can type that is not an integer count of minor units.
const NOT_MINOR_UNITS = [
  '500.0',
  '1e3',
  'abc',
  '1_0',
  'Infinity',
  'NaN',
  '-1',
  '+1',
  '0x10',
  '',
  ' 1',
  '9'.repeat(40),
];

const token = (amount: unknown): unknown => ({
  amount,
  asset: 'USDC',
  network: 'stellar:pubnet',
  scale: 7,
});

const account = (balance: unknown): unknown => ({
  mandateId: '00000000-0000-4000-8000-000000000001',
  mandateName: 'Fixture Mandate 01',
  mandateInstanceId: '00000000-0000-4000-8000-000000000002',
  status: 'active',
  network: 'stellar:pubnet',
  asset: 'USDC',
  fundingAddress: 'CFIXTUREMANDATEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX000001',
  balance,
  lowBalance: { runwayDays: 7, fixed: null, triggered: false, firedBy: [], since: null },
});

const balanceWith = (field: string, amount: unknown): unknown => ({
  total: token('1000'),
  available: token('400'),
  pending: token('400'),
  committed: token('200'),
  [field]: token(amount),
});

/** Parses and reports a throw as a failure rather than letting it escape. */
function outcome(parse: () => { success: boolean }): string {
  try {
    return parse().success ? 'accepted' : 'refused';
  } catch (error) {
    return `threw ${error instanceof Error ? error.constructor.name : 'unknown'}`;
  }
}

describe('safeParse never throws', () => {
  it('refuses a payout amount filter that is not an integer count of minor units', () => {
    for (const bad of NOT_MINOR_UNITS) {
      expect(
        outcome(() =>
          PayoutListQuery.safeParse({ amountCurrency: 'USD', amountMin: bad, amountMax: '900' }),
        ),
        `amountMin=${bad}`,
      ).toBe('refused');
      expect(
        outcome(() =>
          PayoutListQuery.safeParse({ amountCurrency: 'USD', amountMin: '9', amountMax: bad }),
        ),
        `amountMax=${bad}`,
      ).toBe('refused');
    }
  });

  it('answers the documented problem code for an unparseable amount filter', () => {
    for (const bad of ['500.0', 'abc', '1e3']) {
      const result = parseQuery('listPayouts', {
        amountCurrency: 'USD',
        amountMin: bad,
        amountMax: '900',
      });
      expect(result.success, bad).toBe(false);
      if (!result.success) {
        expect(result.code, bad).toBe('INVALID_FILTER');
        expect(
          result.errors.map((e) => e.field),
          bad,
        ).toContain('amountMin');
      }
    }
    // The inverted range still reaches its own code, so the guard did not
    // swallow the check it protects.
    const inverted = parseQuery('listPayouts', {
      amountCurrency: 'USD',
      amountMin: '9',
      amountMax: '1',
    });
    expect(inverted.success).toBe(false);
    if (!inverted.success) {
      expect(inverted.errors).toEqual([{ field: 'amountMin', code: 'range_inverted' }]);
    }
  });

  it('refuses every unparseable funding balance amount', () => {
    const outcomes = new Set<string>();
    for (const field of ['total', 'available', 'pending', 'committed']) {
      for (const bad of NOT_MINOR_UNITS) {
        outcomes.add(
          outcome(() => FundingAccount.safeParse(account(balanceWith(field, bad)))) +
            ` (${field}=${bad})`,
        );
      }
    }
    const threw = [...outcomes].filter((o) => o.startsWith('threw'));
    expect(threw).toEqual([]);
    expect([...outcomes].every((o) => o.startsWith('refused'))).toBe(true);
    // A well formed balance still has its derived rule applied.
    expect(outcome(() => FundingAccount.safeParse(account(balanceWith('available', '400'))))).toBe(
      'accepted',
    );
    expect(outcome(() => FundingAccount.safeParse(account(balanceWith('available', '401'))))).toBe(
      'refused',
    );
  });

  it('refuses an unparseable take or refunded take on a receipt', () => {
    // A complete receipt, so the refinement is actually reached: a missing
    // field fails the structure and the refinement never runs.
    const receipt = generateFixtures({ seed: 3 }).receipts[0];
    expect(receipt).toBeDefined();
    if (receipt === undefined) return;
    expect(outcome(() => PrincipalReceipt.safeParse(receipt))).toBe('accepted');
    for (const field of ['take', 'takeRefunded'] as const) {
      for (const bad of NOT_MINOR_UNITS) {
        expect(
          outcome(() =>
            PrincipalReceipt.safeParse({ ...receipt, [field]: { ...receipt[field], amount: bad } }),
          ),
          `${field}=${bad}`,
        ).toBe('refused');
      }
    }
  });

  // The schemas above are the ones that convert text today. This holds the
  // whole surface to the same promise, so a refinement added later that
  // reads an amount without checking it is caught here rather than in
  // production.
  it('never throws for any shape of hostile input', () => {
    const schemas = [
      ['Money', Money],
      ['TokenAmount', TokenAmount],
      ['PayoutListQuery', PayoutListQuery],
      ['PayoutDetail', PayoutDetail],
      ['MandateDetail', MandateDetail],
      ['FundingAccount', FundingAccount],
      ['PrincipalReceipt', PrincipalReceipt],
      ['ApprovalItem', ApprovalItem],
    ] as const;
    const hostile = fc.oneof(
      fc.constantFrom(...NOT_MINOR_UNITS),
      fc.string(),
      fc.double(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.array(fc.string(), { maxLength: 3 }),
      fc.dictionary(fc.string(), fc.string(), { maxKeys: 3 }),
    );
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(
            'amount',
            'amountMin',
            'amountMax',
            'take',
            'takeRefunded',
            'balance',
            'total',
            'available',
            'pending',
            'committed',
            'charged',
            'settlement',
            'limit',
            'cursor',
            'status',
            'takeBps',
            'revision',
            'legCount',
            'approvals',
            'charges',
          ),
          hostile,
          { maxKeys: 6 },
        ),
        (input) => {
          for (const [name, schema] of schemas) {
            const result = outcome(() => schema.safeParse(input));
            expect(result, `${name} on ${JSON.stringify(input)}`).not.toMatch(/^threw/);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
