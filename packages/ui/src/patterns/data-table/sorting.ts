// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { compare } from '@ujira/core';
import type { Money } from '@ujira/core';

/**
 * Orders amounts for a table column: by currency code first, so amounts in
 * one currency stay together and two currencies are never compared as if
 * they were one, then exactly by amount. For a column that should rank every
 * row on one scale, sort on the USD equivalent instead.
 */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  if (a.currency !== b.currency) return a.currency < b.currency ? -1 : 1;
  return compare(a, b);
}
