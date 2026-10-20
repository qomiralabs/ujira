// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { Braces, LayoutGrid, Settings, Wallet } from 'lucide-react';

import type { IconSource } from './icon';

export interface NavItem {
  /** Path segment under the root; the empty string is Overview at "/". */
  segment: string;
  label: string;
  icon: IconSource;
  /** One line under the page title saying what the page is for. */
  summary: string;
  /** Primary items sit at the top of the rail, the rest at its foot. */
  group: 'primary' | 'secondary';
}

export const NAV_ITEMS = [
  {
    segment: '',
    label: 'Overview',
    icon: { lucide: LayoutGrid },
    summary: 'What this project has paid, what is waiting, and how long the money will last.',
    group: 'primary',
  },
  {
    segment: 'payouts',
    label: 'Payouts',
    icon: { brand: 'payout' },
    summary: 'Every payout this project has made, newest first.',
    group: 'primary',
  },
  {
    segment: 'approvals',
    label: 'Approvals',
    icon: { brand: 'approval' },
    summary: 'Payouts that need someone to say yes before the money moves.',
    group: 'primary',
  },
  {
    segment: 'mandates',
    label: 'Mandates',
    icon: { brand: 'mandate' },
    summary: 'The spending limits and rules that decide which payouts can go ahead.',
    group: 'primary',
  },
  {
    segment: 'recipients',
    label: 'Recipients',
    icon: { brand: 'recipient' },
    summary: 'The people this project pays.',
    group: 'primary',
  },
  {
    segment: 'receipts',
    label: 'Receipts',
    icon: { brand: 'receipt' },
    summary: 'Proof that each person was paid, with the amount and the date.',
    group: 'primary',
  },
  {
    segment: 'funding',
    label: 'Funding',
    icon: { lucide: Wallet },
    summary: 'The money you have put in, and how much is left to pay with.',
    group: 'primary',
  },
  {
    segment: 'corridors',
    label: 'Corridors',
    icon: { brand: 'rail' },
    summary: 'The countries you can pay into, and how the money reaches people there.',
    group: 'primary',
  },
  {
    segment: 'developers',
    label: 'Developers',
    icon: { lucide: Braces },
    summary: 'Keys, webhooks and logs for connecting your own software.',
    group: 'secondary',
  },
  {
    segment: 'settings',
    label: 'Settings',
    icon: { lucide: Settings },
    summary: 'Your team, what each person may do, and what they are told about.',
    group: 'secondary',
  },
] as const satisfies readonly NavItem[];

export type Section = Exclude<(typeof NAV_ITEMS)[number]['segment'], ''>;

export function hrefFor(item: Pick<NavItem, 'segment'>): string {
  return `/${item.segment}`;
}

/** The nav item a pathname belongs to; nested paths count for their section. */
export function activeItem(pathname: string | null): NavItem | undefined {
  const first = (pathname ?? '/').split('/')[1] ?? '';
  return NAV_ITEMS.find((item) => item.segment === first);
}
