// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import {
  formatMoney as formatCoreMoney,
  formatTokenAmount,
  isNegative,
  isZero,
  money,
  negate,
} from '@ujira/core';
import type {
  CurrencyCodeDisplay,
  FiatCurrencyCode,
  Money,
  TokenAmount as CoreTokenAmount,
} from '@ujira/core';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { useAmountSettings } from './amount-context.js';
import { AMOUNT_SIZES, AMOUNT_TEXT, SECONDARY_SIZES, type AmountSize } from './amount-styles.js';
import { localeDirection, type MinorUnits } from './format.js';

const MINUS = '\u2212';

/**
 * How the sign shows. `auto` marks only a negative amount. `exceptZero` also
 * marks a positive one with a plus, for a change such as a refund or a top
 * up. `never` drops it, for a column whose heading already says the
 * direction.
 */
export type SignDisplay = 'auto' | 'exceptZero' | 'never';

type AmountSource =
  | { value: Money; minor?: never; currency?: never }
  | { value?: never; minor: MinorUnits; currency: FiatCurrencyCode };

export type AmountProps = AmountSource & {
  /**
   * A second amount shown under the first, smaller: the USD or USDC
   * equivalent of a local currency amount.
   */
  secondary?: Money | CoreTokenAmount;
  /** Read before the secondary amount by screen readers only. */
  secondaryLabel?: string;
  signDisplay?: SignDisplay;
  size?: AmountSize;
} & Omit<ComponentProps<'span'>, 'children' | 'dir'>;

interface FormatSettings {
  locale: string;
  currencyCode: CurrencyCodeDisplay;
}

/** The Money to show. The types already require one source; this holds for untyped callers. */
function moneyOf(value?: Money, minor?: MinorUnits, currency?: FiatCurrencyCode): Money {
  if (value !== undefined) return value;
  if (minor === undefined || currency === undefined) {
    throw new TypeError('Amount needs a value, or minor units and a currency');
  }
  return money(minor, currency);
}

/**
 * The core formatter's text with the sign shown as asked. The plus sign
 * takes the place the locale gives its minus sign, so a right to left
 * locale puts both on the same side.
 */
function signedText(amount: Money, sign: SignDisplay, settings: FormatSettings): string {
  if (sign === 'never' && isNegative(amount)) return formatCoreMoney(negate(amount), settings);
  if (sign === 'exceptZero' && !isNegative(amount) && !isZero(amount)) {
    return formatCoreMoney(negate(amount), settings).replace(MINUS, '+');
  }
  return formatCoreMoney(amount, settings);
}

function secondaryText(amount: Money | CoreTokenAmount, settings: FormatSettings): string {
  return amount.kind === 'token'
    ? formatTokenAmount(amount, { locale: settings.locale })
    : formatCoreMoney(amount, settings);
}

/**
 * A fiat amount, exactly as the core money model formats it, in the mono
 * face with tabular figures. Pass a Money, or integer minor units with their
 * currency; a number does not compile. The locale and the dollar code rule
 * come from the nearest AmountProvider.
 *
 * The amount is its own bidirectional run with the locale's direction, so
 * the sign, the digits and the code keep their order inside any sentence or
 * page. In a table, right align the cell; tabular figures line the digits up.
 */
export function Amount({
  value,
  minor,
  currency,
  secondary,
  secondaryLabel = 'equal to',
  signDisplay = 'auto',
  size = 'inherit',
  className,
  ...rest
}: AmountProps) {
  const amount = moneyOf(value, minor, currency);
  const settings = useAmountSettings();
  const dir = localeDirection(settings.locale);
  const text = signedText(amount, signDisplay, settings);

  if (secondary === undefined) {
    return (
      <span
        data-slot="amount-value"
        dir={dir}
        className={cn(AMOUNT_TEXT, AMOUNT_SIZES[size], className)}
        {...rest}
      >
        {text}
      </span>
    );
  }
  return (
    <span data-slot="amount" className={cn('inline-flex flex-col items-end', className)} {...rest}>
      <span data-slot="amount-value" dir={dir} className={cn(AMOUNT_TEXT, AMOUNT_SIZES[size])}>
        {text}
      </span>
      <span
        data-slot="amount-secondary"
        className={cn(AMOUNT_TEXT, SECONDARY_SIZES[size], 'text-text-secondary')}
      >
        <span className="sr-only">{secondaryLabel}</span>{' '}
        <span data-slot="amount-value" dir={dir}>
          {secondaryText(secondary, settings)}
        </span>
      </span>
    </span>
  );
}
