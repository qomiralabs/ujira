// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/**
 * Every amount: the mono stack (the brand mono face, with the second mono
 * face first for the naira, cedi, peso and rupee signs), tabular figures so
 * columns line up, and never broken across lines.
 */
export const AMOUNT_TEXT = 'font-mono tabular-nums whitespace-nowrap';

/**
 * Where an amount sits in the type scale. `inherit` takes the size around it.
 * `hero` is the amount a payment surface leads with: it steps down below the
 * small breakpoint rather than wrap or push a phone screen sideways.
 */
export type AmountSize = 'inherit' | 'data' | 'large' | 'hero';

export const AMOUNT_SIZES: Readonly<Record<AmountSize, string>> = Object.freeze({
  inherit: '',
  data: 'text-data',
  large: 'text-amount-l',
  hero: 'text-amount-l sm:text-amount-xl',
});

// The secondary amount is a step smaller than the one it explains.
export const SECONDARY_SIZES: Readonly<Record<AmountSize, string>> = Object.freeze({
  inherit: 'text-[0.85em]',
  data: 'text-[0.75rem]',
  large: 'text-body-s',
  hero: 'text-body-s sm:text-body',
});
