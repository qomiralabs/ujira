// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

'use client';

import { dollarSignAmbiguous } from '@ujira/core';
import type { CurrencyCodeDisplay, FiatCurrencyCode, TokenAsset } from '@ujira/core';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

export interface AmountSettings {
  /** The language tag every amount below is formatted for. */
  locale: string;
  /** Whether dollar amounts carry their ISO code. */
  currencyCode: CurrencyCodeDisplay;
}

// A recipient surface sets nothing, and keeps the plain dollar sign.
const RECIPIENT_DEFAULT: AmountSettings = Object.freeze({ locale: 'en', currencyCode: 'never' });

const AmountContext = createContext<AmountSettings>(RECIPIENT_DEFAULT);

export interface AmountProviderProps {
  locale: string;
  /**
   * The currencies of the principal's corridors. Principal views pass them
   * once, at the top of the view, and every dollar amount below carries its
   * ISO code when two of them print as "$". Leave it out on recipient
   * surfaces. It is the corridors, not the rows on screen, so filtering a
   * table never changes how its amounts read.
   */
  corridorCurrencies?: readonly (FiatCurrencyCode | TokenAsset)[];
  children: ReactNode;
}

/** Sets the locale, and for principal views the dollar code rule, for every amount inside. */
export function AmountProvider({ locale, corridorCurrencies, children }: AmountProviderProps) {
  const ambiguous =
    corridorCurrencies === undefined ? false : dollarSignAmbiguous(corridorCurrencies);
  const settings = useMemo<AmountSettings>(
    () => ({ locale, currencyCode: ambiguous ? 'whenAmbiguous' : 'never' }),
    [locale, ambiguous],
  );
  return <AmountContext value={settings}>{children}</AmountContext>;
}

/** The amount settings in force here: the provider's, or the recipient default. */
export function useAmountSettings(): AmountSettings {
  return useContext(AmountContext);
}
