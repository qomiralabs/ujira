// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the fee builder (fee-builder.ts), CHAINOPS-FEE-002.
 *
 * - applyFee applies min(rate, max_fee_bps), or 0 for internal_at_cost terms,
 *   and the fee is feeCap(total, bps) exactly: UJIRA's take and nothing else.
 *   charged = total + fee, and the terms row is named even when the fee is 0.
 * - feeForPayout uses the terms in force when the payout was requested, never
 *   later ones, and refuses to price a payout with no terms at all.
 * - withFee puts the fee on the request only for the total it was worked
 *   out on.
 */

import { describe, expect, it } from 'vitest';

import type { PayRequest, TenantScope, Uuid } from '@ujira/chain-adapter';
import { feeCap, tokenAmount } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';

import {
  FeeTermsMissingError,
  FeeTermsNotInForceError,
  applyFee,
  feeForPayout,
  withFee,
} from './index.js';
import type { FeeTerms, FeeTermsSource } from './index.js';

const usdc = (amount: bigint): TokenAmount => tokenAmount(amount, 'USDC', 'stellar');
const SCOPE: TenantScope = {
  principalId: '00000000-0000-4000-8000-000000000001' as Uuid,
  projectId: '00000000-0000-4000-8000-000000000002' as Uuid,
};
const TODAY = new Date('2026-11-04T12:00:00Z');
const TOMORROW = new Date('2026-11-05T00:00:00Z');

const terms = (overrides: Partial<FeeTerms> = {}): FeeTerms => ({
  id: 'terms-1',
  rateBps: 90,
  basis: 'standard',
  validFrom: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

// The latest row at or before the instant, the way fees.termsAt chooses.
function source(rows: readonly FeeTerms[]): FeeTermsSource {
  return {
    termsAt: (_scope, at) => {
      const due = rows
        .filter((r) => r.validFrom.getTime() <= at.getTime())
        .sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
      return Promise.resolve(due[0] ?? null);
    },
  };
}

describe('fee-builder', () => {
  it('tier above max_fee_bps is clamped to the cap', () => {
    const applied = applyFee(usdc(1_000_000n), terms({ rateBps: 100 }), 30);
    expect(applied.bpsApplied).toBe(30);
    expect(applied.fee).toEqual(feeCap(usdc(1_000_000n), 30));
  });

  it('rate 90 with max_fee_bps 50 applies 50 and records the terms row', () => {
    const applied = applyFee(usdc(123_456n), terms({ id: 'terms-7', rateBps: 90 }), 50);
    expect(applied).toEqual({
      total: usdc(123_456n),
      fee: usdc(617n),
      bpsApplied: 50,
      termsId: 'terms-7',
      charged: usdc(124_073n),
    });
  });

  it('applies the rate when it is under the cap', () => {
    expect(applyFee(usdc(10_000n), terms({ rateBps: 20 }), 100).bpsApplied).toBe(20);
  });

  it('internal at-cost payout has fee 0', () => {
    const applied = applyFee(
      usdc(500_000n),
      terms({ basis: 'internal_at_cost', rateBps: 90 }),
      100,
    );
    expect(applied.fee.amount).toBe(0n);
    expect(applied.bpsApplied).toBe(0);
    expect(applied.charged).toEqual(usdc(500_000n));
    // Zero by policy still names the terms it came from.
    expect(applied.termsId).toBe('terms-1');
  });

  it('the fee leg equals feeCap(total, bps) and nothing else, in both cash-out cost modes', () => {
    const delivered = usdc(1_000_000n);
    const anchorCost = usdc(25_000n);
    // The recipient bears the cash-out cost: the total is what was asked for.
    // The principal bears it: the total is grossed up to cover it. Either way
    // the fee is the take on the total the request carries, and the anchor
    // cost reaches the fee only through that total, never as an extra.
    const recipientPays = delivered;
    const principalPays = usdc(delivered.amount + anchorCost.amount);
    for (const total of [recipientPays, principalPays]) {
      const applied = applyFee(total, terms({ rateBps: 75 }), 100);
      expect(applied.fee).toEqual(feeCap(total, 75));
      expect(applied.charged.amount).toBe(total.amount + applied.fee.amount);
    }
  });

  it('terms valid from tomorrow are not used today', async () => {
    const rows = [
      terms({ id: 'old', rateBps: 40 }),
      terms({ id: 'new', rateBps: 80, validFrom: TOMORROW }),
    ];
    const deps = { terms: source(rows) };
    const today = await feeForPayout(
      { scope: SCOPE, total: usdc(10_000n), requestedAt: TODAY, maxFeeBps: 100 },
      deps,
    );
    expect(today.termsId).toBe('old');
    const tomorrow = await feeForPayout(
      { scope: SCOPE, total: usdc(10_000n), requestedAt: TOMORROW, maxFeeBps: 100 },
      deps,
    );
    expect(tomorrow.termsId).toBe('new');
  });

  it('refuses terms a source returns before they are in force', async () => {
    const early: FeeTermsSource = {
      termsAt: () => Promise.resolve(terms({ validFrom: TOMORROW })),
    };
    await expect(
      feeForPayout(
        { scope: SCOPE, total: usdc(10_000n), requestedAt: TODAY, maxFeeBps: 100 },
        { terms: early },
      ),
    ).rejects.toThrow(FeeTermsNotInForceError);
  });

  it('refuses to price a payout with no terms', async () => {
    await expect(
      feeForPayout(
        { scope: SCOPE, total: usdc(10_000n), requestedAt: TODAY, maxFeeBps: 100 },
        { terms: source([]) },
      ),
    ).rejects.toThrow(FeeTermsMissingError);
  });

  it('gives the terms lookup a deadline', async () => {
    let seen: AbortSignal | undefined;
    const slow: FeeTermsSource = {
      termsAt: (_s, _a, { signal }) => {
        seen = signal;
        return Promise.resolve(terms());
      },
    };
    await feeForPayout(
      { scope: SCOPE, total: usdc(10_000n), requestedAt: TODAY, maxFeeBps: 100 },
      { terms: slow, timeoutMs: 1_000 },
    );
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it('puts the fee only on the request for its own total', () => {
    const applied = applyFee(usdc(10_000n), terms({ rateBps: 100 }), 100);
    const base = { total: usdc(10_000n) } as Omit<PayRequest, 'fee'>;
    expect(withFee(base, applied).fee).toEqual(usdc(100n));
    expect(() => withFee({ ...base, total: usdc(9_999n) }, applied)).toThrow(RangeError);
  });

  it('has stable error codes', () => {
    expect(new FeeTermsMissingError().code).toBe('FEE_TERMS_MISSING');
    expect(new FeeTermsNotInForceError().code).toBe('FEE_TERMS_NOT_IN_FORCE');
  });
});
