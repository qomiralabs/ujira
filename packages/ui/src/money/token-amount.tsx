// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { formatTokenAmount } from '@ujira/core';
import type { TokenAmount as CoreTokenAmount } from '@ujira/core';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { useAmountSettings } from './amount-context.js';
import { AMOUNT_SIZES, AMOUNT_TEXT, type AmountSize } from './amount-styles.js';
import { localeDirection } from './format.js';

export interface TokenAmountProps extends Omit<ComponentProps<'span'>, 'children' | 'dir'> {
  /** A settlement token amount in raw on chain units, built with the core tokenAmount. */
  value: CoreTokenAmount;
  size?: AmountSize;
}

/**
 * A settlement token amount such as "1.23 USDC", formatted by the core model
 * at two places with its asset code. The chain stays inside the value and is
 * never printed. For principal surfaces and for a recipient who chose a
 * wallet; recipients paid in local currency never see it.
 */
export function TokenAmount({ value, size = 'inherit', className, ...rest }: TokenAmountProps) {
  const { locale } = useAmountSettings();
  return (
    <span
      data-slot="amount-value"
      dir={localeDirection(locale)}
      className={cn(AMOUNT_TEXT, AMOUNT_SIZES[size], className)}
      {...rest}
    >
      {formatTokenAmount(value, { locale })}
    </span>
  );
}
