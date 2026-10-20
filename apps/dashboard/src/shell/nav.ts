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
    summary: 'What this project has paid, what is waiting and how long each mandate will last.',
    group: 'primary',
  },
  {
    segment: 'payouts',
    label: 'Payouts',
    icon: { brand: 'payout' },
    summary: 'Every payout from this project, newest first.',
    group: 'primary',
  },
  {
    segment: 'approvals',
    label: 'Approvals',
    icon: { brand: 'approval' },
    summary: 'Payouts a mandate rule has held for a person to approve.',
    group: 'primary',
  },
  {
    segment: 'mandates',
    label: 'Mandates',
    icon: { brand: 'mandate' },
    summary: 'The budgets and rules every payout is checked against.',
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
    summary: 'Proof of every completed payout.',
    group: 'primary',
  },
  {
    segment: 'funding',
    label: 'Funding',
    icon: { lucide: Wallet },
    summary: 'The money held in your mandates, ready to pay out.',
    group: 'primary',
  },
  {
    segment: 'corridors',
    label: 'Corridors',
    icon: { brand: 'rail' },
    summary: 'Where this project can pay people, and by which methods.',
    group: 'primary',
  },
  {
    segment: 'developers',
    label: 'Developers',
    icon: { lucide: Braces },
    summary: 'API keys, webhooks, request logs and the MCP server.',
    group: 'secondary',
  },
  {
    segment: 'settings',
    label: 'Settings',
    icon: { lucide: Settings },
    summary: 'Your team, their roles and the notifications they get.',
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
