// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { money } from '@ujira/core';
import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../primitives/button.js';
import { KpiCard, deltaText } from './kpi-card.js';

afterEach(cleanup);

describe('KpiCard', { timeout: 30_000 }, () => {
  it('the delta reads up, down or no change with the percentage and the period', () => {
    expect(deltaText({ change: 'up', percent: '12', comparedWith: 'last week' })).toBe(
      'Up 12 percent on last week',
    );
    expect(deltaText({ change: 'down', percent: '3.5', comparedWith: 'last month' })).toBe(
      'Down 3.5 percent on last month',
    );
    expect(deltaText({ change: 'none', comparedWith: 'last week' })).toBe('No change on last week');
    render(
      <KpiCard
        title="Paid this week"
        value={{ amount: money('12500000', 'USD') }}
        period="1 to 7 Nov"
        delta={{ change: 'up', percent: '12', comparedWith: 'last week' }}
      />,
    );
    expect(screen.getByText('Up 12 percent on last week')).toBeTruthy();
  });

  it('refuses a percentage that is not a plain decimal', () => {
    for (const percent of ['', '-3', '1e3', '12%', '0x10', ' 5']) {
      expect(
        () => deltaText({ change: 'up', percent, comparedWith: 'last week' }),
        percent,
      ).toThrow();
    }
  });

  it('the value renders final on first paint', () => {
    // The server markup is the first paint. It already holds the exact value:
    // there is no zero to count up from, and no animation to start.
    const html = renderToStaticMarkup(
      <KpiCard
        title="Paid this week"
        value={{ amount: money('12500000', 'USD') }}
        period="1 to 7 Nov"
      />,
    );
    expect(html).toContain('$125,000.00');
    expect(html).not.toMatch(/\$0\.00/);
    expect(html).not.toMatch(/animate|transition/);
  });

  it('shows one number: an amount, a count or a short text, in the mono face', () => {
    const { rerender } = render(
      <KpiCard title="Payouts completed" value={{ count: 1284 }} period="This week" />,
    );
    const value = () => document.querySelector('[data-slot="kpi-value"]');
    expect(value()?.textContent).toBe('1,284');
    expect(value()?.className).toContain('font-mono');
    expect(value()?.className).toContain('tabular-nums');
    rerender(<KpiCard title="Median time to paid" value={{ text: '4 min' }} period="This week" />);
    expect(value()?.textContent).toBe('4 min');
    rerender(
      <KpiCard title="Paid this week" value={{ amount: money('250', 'NGN') }} period="This week" />,
    );
    expect(value()?.textContent).toBe('₦2.50');
  });

  it('refuses a count that is not a whole number', () => {
    expect(() =>
      render(<KpiCard title="Payouts completed" value={{ count: 1.5 }} period="This week" />),
    ).toThrow();
  });

  it('is a quiet card with a title, the period, one action at most, and a slot for a sparkline', () => {
    render(
      <KpiCard
        title="Blocked by policy"
        value={{ count: 3 }}
        period="This week"
        sparkline={<svg data-testid="sparkline" />}
        action={<Button>Review blocked payouts</Button>}
      />,
    );
    const card = screen.getByRole('region', { name: 'Blocked by policy' });
    expect(card.className).toContain('rounded-card');
    expect(card.className).toContain('border-rule');
    expect(card.className).not.toContain('shadow');
    expect(card.textContent).toContain('This week');
    expect(card.querySelectorAll('button')).toHaveLength(1);
    expect(screen.getByTestId('sparkline').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(card.querySelector('[data-slot="kpi-card"]')).toBeNull();
  });
});
