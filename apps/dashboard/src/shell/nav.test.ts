// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { activeItem, hrefFor, NAV_ITEMS } from './nav';
import { PLACEHOLDERS } from './placeholders';
import { PROJECTS } from './projects';

describe('navigation', () => {
  it('lists the ten sections in order, in sentence case', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      'Overview',
      'Payouts',
      'Approvals',
      'Mandates',
      'Recipients',
      'Receipts',
      'Funding',
      'Corridors',
      'Developers',
      'Settings',
    ]);
    expect(NAV_ITEMS.filter((item) => item.group === 'secondary').map((i) => i.label)).toEqual([
      'Developers',
      'Settings',
    ]);
  });

  it('uses the brand icon wherever the brand has one for the idea', () => {
    const brand = Object.fromEntries(
      NAV_ITEMS.flatMap((item) => ('brand' in item.icon ? [[item.label, item.icon.brand]] : [])),
    );
    expect(brand).toEqual({
      Payouts: 'payout',
      Approvals: 'approval',
      Mandates: 'mandate',
      Recipients: 'recipient',
      Receipts: 'receipt',
      Corridors: 'rail',
    });
  });

  it('links Overview to the root and every other section to its segment', () => {
    expect(NAV_ITEMS.map(hrefFor)).toEqual([
      '/',
      '/payouts',
      '/approvals',
      '/mandates',
      '/recipients',
      '/receipts',
      '/funding',
      '/corridors',
      '/developers',
      '/settings',
    ]);
  });

  it.each([
    ['/', 'Overview'],
    [null, 'Overview'],
    ['/payouts', 'Payouts'],
    ['/payouts/po_123', 'Payouts'],
    ['/developers/webhooks', 'Developers'],
  ])('marks %s as part of %s', (pathname, label) => {
    expect(activeItem(pathname)?.label).toBe(label);
  });

  it('marks nothing for a path outside the navigation', () => {
    expect(activeItem('/nowhere')).toBeUndefined();
  });

  it('gives every section placeholder copy', () => {
    expect(Object.keys(PLACEHOLDERS).sort()).toEqual(
      ['overview', ...NAV_ITEMS.filter((i) => i.segment !== '').map((i) => i.segment)].sort(),
    );
  });

  it('gives every page one plain line saying what it is', () => {
    for (const item of NAV_ITEMS) {
      expect(item.summary.length, item.label).toBeGreaterThan(10);
      expect(item.summary.endsWith('.'), item.label).toBe(true);
    }
  });

  it('leaves projects to their own names, which the principal chose', () => {
    for (const project of PROJECTS) {
      expect(Object.keys(project).sort(), project.name).toEqual(['id', 'name']);
    }
  });

  it('keeps every line a person reads free of words only this team uses', () => {
    const jargon =
      /\b(utilis\w+|leverage\w*|onboard\w*|provision\w*|enumerate|idempoten\w+|tenant|principal'?s?|payload|endpoint|invoke\w*|orchestrat\w*|SLA|KYC|median|rail)\b/i;
    const lines = [
      ...NAV_ITEMS.map((item) => item.summary),
      ...Object.values(PLACEHOLDERS).flatMap((p) => [p.title, p.body]),
    ];
    for (const line of lines) expect(line, line).not.toMatch(jargon);
  });

  it('says people and recipients, never users or workers, and paid, never transferred', () => {
    const copy = [
      ...NAV_ITEMS.flatMap((item) => [item.label, item.summary]),
      ...Object.values(PLACEHOLDERS).flatMap((p) => [p.title, p.body]),
    ].join('\n');
    expect(copy).not.toMatch(/\b(users?|workers?|transferred|sent funds)\b/i);
    // No em or en dashes. Built from code points so this file holds neither.
    const dashes = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);
    expect(copy).not.toMatch(dashes);
  });
});
