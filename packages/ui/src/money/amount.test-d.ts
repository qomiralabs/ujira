// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Compile time checks on the amount components, run by typecheck. Each
// ts-expect-error is an assertion: if the line ever compiles, typecheck fails
// with an unused directive.

import { money, tokenAmount } from '@ujira/core';
import { describe, expectTypeOf, it } from 'vitest';
import type { AmountProps } from './amount.js';
import { formatMoney } from './format.js';
import type { TokenAmountProps } from './token-amount.js';

describe('amount types', () => {
  it('a number amount does not compile', () => {
    // @ts-expect-error a float is never an amount
    const float: AmountProps = { minor: 1.5, currency: 'USD' };
    // @ts-expect-error nor is a whole number, which reads as major units
    const whole: AmountProps = { minor: 96, currency: 'USD' };
    // @ts-expect-error the value must be a Money, not a number
    const value: AmountProps = { value: 1.5 };
    // @ts-expect-error the secondary amount is a Money or a token amount
    const secondary: AmountProps = { minor: 96n, currency: 'USD', secondary: 0.06 };
    // @ts-expect-error formatMoney takes bigint minor units or their decimal string
    formatMoney(1.5, 'USD', 'en');
    expectTypeOf([float, whole, value, secondary]).toBeArray();
  });

  it('takes a Money or minor units with a currency, never both and never neither', () => {
    expectTypeOf({ value: money('9600', 'USD') }).toExtend<AmountProps>();
    expectTypeOf({ minor: 9600n, currency: 'USD' as const }).toExtend<AmountProps>();
    expectTypeOf({ minor: '9600', currency: 'USD' as const }).toExtend<AmountProps>();
    // @ts-expect-error a value and minor units together are ambiguous
    const both: AmountProps = { value: money('9600', 'USD'), minor: 9600n, currency: 'USD' };
    // @ts-expect-error minor units mean nothing without their currency
    const bare: AmountProps = { minor: 9600n };
    // @ts-expect-error an amount needs something to show
    const empty: AmountProps = {};
    expectTypeOf([both, bare, empty]).toBeArray();
  });

  it('keeps fiat and token amounts apart', () => {
    // @ts-expect-error a token amount is shown with TokenAmount, not Amount
    const token: AmountProps = { value: tokenAmount('1', 'USDC', 'stellar') };
    // @ts-expect-error a fiat amount is not a token amount
    const fiat: TokenAmountProps = { value: money('9600', 'USD') };
    // @ts-expect-error currency codes come from the core table
    const unknown: AmountProps = { minor: 9600n, currency: 'CAD' };
    expectTypeOf([token, fiat, unknown]).toBeArray();
  });
});
