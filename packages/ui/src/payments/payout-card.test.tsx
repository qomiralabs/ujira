// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { money, tokenAmount } from '@ujira/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../primitives/button.js';
import { PayoutCard } from './payout-card.js';

afterEach(cleanup);

const BASE = {
  recipient: 'Wanjiru Kamau',
  amount: money('150000', 'KES'),
  status: 'paid',
  method: 'USDC to Stellar wallet',
  corridor: 'Kenya',
} as const;

// The first render loads React and the money model, which is slow on a loaded runner.
describe('PayoutCard', { timeout: 30_000 }, () => {
  it('leads with the recipient and the amount, then the status, method and corridor', () => {
    render(<PayoutCard {...BASE} />);
    const card = screen.getByRole('article', { name: 'Wanjiru Kamau' });
    expect(card.textContent).toContain('KSh\u00a01,500.00');
    expect(card.querySelector('[data-slot="status-badge"]')?.textContent).toBe('Paid');
    const details = card.querySelector('dl');
    expect(details?.textContent).toContain('MethodUSDC to Stellar wallet');
    expect(details?.textContent).toContain('CorridorKenya');
  });

  it('puts a perforation rule between the amount and the details', () => {
    const { container } = render(<PayoutCard {...BASE} />);
    const order = [
      ...container.querySelectorAll('[data-slot="amount-value"], [data-slot="perforation"], dl'),
    ].map((node) => node.getAttribute('data-slot') ?? node.tagName.toLowerCase());
    expect(order).toEqual(['amount-value', 'perforation', 'dl']);
    const rule = container.querySelector('[data-slot="perforation"]');
    expect(rule?.getAttribute('aria-hidden')).toBe('true');
    expect(rule?.className).toContain('border-dotted');
  });

  it('shows the amount at the large step and a secondary amount under it', () => {
    const { container } = render(
      <PayoutCard {...BASE} secondary={tokenAmount('116000000', 'USDC', 'stellar')} />,
    );
    const values = [...container.querySelectorAll('[data-slot="amount-value"]')];
    expect(values.map((node) => node.textContent)).toEqual([
      'KSh\u00a01,500.00',
      '11.60\u00a0USDC',
    ]);
    expect(values[0]?.className).toContain('text-amount-l');
  });

  it('is a quiet card: a 1px rule, the card radius, no shadow', () => {
    render(<PayoutCard {...BASE} />);
    const classes = screen.getByRole('article').className.split(' ');
    expect(classes).toEqual(
      expect.arrayContaining(['border', 'border-rule', 'rounded-card', 'bg-surface']),
    );
    expect(classes.filter((name) => name.startsWith('shadow'))).toEqual([]);
    // A long name truncates in a narrow grid column instead of widening the card.
    expect(classes).toContain('min-w-0');
  });

  it('moves the status under the name, rather than cut the name, when both do not fit', () => {
    render(<PayoutCard {...BASE} />);
    const header = screen.getByRole('heading', { name: 'Wanjiru Kamau' }).parentElement;
    expect(header?.className.split(' ')).toContain('flex-wrap');
  });

  it('carries one action at most, after the details', () => {
    render(<PayoutCard {...BASE} status="pending_approval" action={<Button>Review</Button>} />);
    const card = screen.getByRole('article');
    expect(card.querySelectorAll('button')).toHaveLength(1);
    expect(card.lastElementChild?.querySelector('button')?.textContent).toBe('Review');
  });

  it('adds when it arrives or was paid as its own detail', () => {
    render(<PayoutCard {...BASE} timing={{ label: 'Paid', value: '4 Nov 2026, 14:02' }} />);
    expect(screen.getByRole('article').querySelector('dl')?.textContent).toContain(
      'Paid4 Nov 2026, 14:02',
    );
  });

  it('has no action by default', () => {
    render(<PayoutCard {...BASE} />);
    expect(screen.getByRole('article').querySelector('button')).toBeNull();
  });
});
