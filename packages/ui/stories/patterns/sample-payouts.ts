// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Seeded sample payouts for the catalogue. The same seed always gives the
// same rows, so the screenshots never change on their own.

import { money } from '@ujira/core';
import type { FiatCurrencyCode, Money } from '@ujira/core';
import type { BadgeStatus } from '../../src/payments/status-badge.js';

export interface SamplePayout {
  id: string;
  recipient: string;
  amount: Money;
  usd: Money;
  status: BadgeStatus;
  corridor: string;
  created: string;
}

const PEOPLE = [
  'Amara Okafor',
  'Kwame Mensah',
  'Wanjiru Kamau',
  'Maria Santos',
  'Priya Nair',
  'Chidi Eze',
  'Akosua Boateng',
  'Otieno Odhiambo',
  'Joseph Dela Cruz',
  'Ananya Rao',
  'Thandiwe Dlamini',
  'Lucas Oliveira',
] as const;

// Each corridor with its currency and how many minor units make one US cent,
// as a whole number, so no rate arithmetic is ever a float.
const CORRIDORS: readonly { country: string; currency: FiatCurrencyCode; perCent: bigint }[] = [
  { country: 'Nigeria', currency: 'NGN', perCent: 16n },
  { country: 'Ghana', currency: 'GHS', perCent: 12n },
  { country: 'Kenya', currency: 'KES', perCent: 129n },
  { country: 'Philippines', currency: 'PHP', perCent: 57n },
  { country: 'India', currency: 'INR', perCent: 83n },
  { country: 'South Africa', currency: 'ZAR', perCent: 18n },
  { country: 'Brazil', currency: 'BRL', perCent: 5n },
];

const STATUSES: readonly BadgeStatus[] = [
  'paid',
  'paid',
  'paid',
  'settling',
  'delivering',
  'pending_approval',
  'queued',
  'failed',
  'blocked',
  'paid',
];

// A small linear congruential generator over bigints: deterministic and free
// of floating point.
function generator(seed: bigint) {
  let state = seed;
  return (bound: bigint): bigint => {
    state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    return (state >> 16n) % bound;
  };
}

export function samplePayouts(count: number, seed = 7n): SamplePayout[] {
  const next = generator(seed);
  return Array.from({ length: count }, (_, index) => {
    const corridor = CORRIDORS[Number(next(BigInt(CORRIDORS.length)))] ?? CORRIDORS[0];
    if (corridor === undefined) throw new Error('no corridors');
    const cents = 500n + next(250_000n);
    const day = 1n + next(28n);
    const hour = next(24n);
    const minute = next(60n);
    return {
      id: `po_${String(index + 1).padStart(6, '0')}`,
      recipient: PEOPLE[index % PEOPLE.length] ?? 'Recipient',
      amount: money(cents * corridor.perCent, corridor.currency),
      usd: money(cents, 'USD'),
      status: STATUSES[Number(next(BigInt(STATUSES.length)))] ?? 'paid',
      corridor: corridor.country,
      created: `${String(day)} Oct 2026, ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    };
  });
}
