// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { money } from '@ujira/core';
import { cleanup, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { MandateMeter, meterSegments, percentOf } from './mandate-meter.js';

afterEach(cleanup);

const usd = (minor: string) => money(minor, 'USD');

/** The width of each drawn segment, as the SVG carries it. */
function widths(): Record<string, string | null> {
  const read = (segment: string) =>
    document.querySelector(`[data-segment="${segment}"]`)?.getAttribute('width') ?? null;
  return { used: read('used'), committed: read('committed'), remaining: read('remaining') };
}

describe('meterSegments', () => {
  it('splits the budget into basis points with integer division, and the parts add up', () => {
    const segments = meterSegments(usd('500000'), usd('120000'), usd('30000'));
    expect(segments.usedBp).toBe(2400n);
    expect(segments.committedBp).toBe(600n);
    expect(segments.remainingBp).toBe(7000n);
    expect(segments.remaining).toEqual(usd('350000'));
    expect(segments.over).toEqual(usd('0'));
  });

  it('rounds down each part and gives the rest to what remains', () => {
    // A third of a dollar of three: 3333.33 basis points, floored.
    const segments = meterSegments(usd('300'), usd('100'), usd('100'));
    expect(segments.usedBp).toBe(3333n);
    expect(segments.committedBp).toBe(3333n);
    expect(segments.remainingBp).toBe(3334n);
  });

  it('always fills exactly the whole bar, for any amounts', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        (budget, used, committed) => {
          const s = meterSegments(
            usd(budget.toString()),
            usd(used.toString()),
            usd(committed.toString()),
          );
          expect(s.usedBp + s.committedBp + s.remainingBp).toBe(10_000n);
          for (const part of [s.usedBp, s.committedBp, s.remainingBp]) {
            expect(part >= 0n && part <= 10_000n).toBe(true);
          }
        },
      ),
    );
  });

  it('shows nothing remaining and the excess when the budget is overrun', () => {
    const segments = meterSegments(usd('500000'), usd('400000'), usd('200000'));
    expect(segments.usedBp).toBe(8000n);
    expect(segments.committedBp).toBe(2000n);
    expect(segments.remainingBp).toBe(0n);
    expect(segments.remaining).toEqual(usd('0'));
    expect(segments.over).toEqual(usd('100000'));
  });

  it('draws an empty bar for a zero budget rather than dividing by zero', () => {
    const segments = meterSegments(usd('0'), usd('0'), usd('0'));
    expect([segments.usedBp, segments.committedBp, segments.remainingBp]).toEqual([0n, 0n, 0n]);
  });

  it('refuses amounts in different currencies', () => {
    expect(() => meterSegments(usd('100'), money('100', 'NGN'), usd('0'))).toThrow();
  });
});

describe('percentOf', () => {
  it.each([
    [0n, '0.00%'],
    [5n, '0.05%'],
    [600n, '6.00%'],
    [3333n, '33.33%'],
    [10_000n, '100.00%'],
  ])('%s basis points is %s', (bp, text) => {
    expect(percentOf(bp)).toBe(text);
  });
});

// The first render loads React and the money model, which is slow on a loaded runner.
describe('MandateMeter', { timeout: 30_000 }, () => {
  it('segments are proportional with integer arithmetic, and the text alternative states every amount', () => {
    render(<MandateMeter budget={usd('500000')} used={usd('120000')} committed={usd('30000')} />);
    expect(widths()).toEqual({ used: '24.00%', committed: '6.00%', remaining: '70.00%' });
    expect(
      screen.getByRole('img', {
        name: '$1,200.00 used, $300.00 committed, $3,500.00 remaining of $5,000.00',
      }),
    ).toBeTruthy();
  });

  it('committed above remaining still reads in order', () => {
    render(<MandateMeter budget={usd('500000')} used={usd('120000')} committed={usd('300000')} />);
    expect(widths()).toEqual({ used: '24.00%', committed: '60.00%', remaining: '16.00%' });
    expect(
      screen.getByRole('img', {
        name: '$1,200.00 used, $3,000.00 committed, $800.00 remaining of $5,000.00',
      }),
    ).toBeTruthy();
  });

  it('a zero budget draws an empty bar and says so', () => {
    render(<MandateMeter budget={usd('0')} used={usd('0')} committed={usd('0')} />);
    expect(widths()).toEqual({ used: '0.00%', committed: '0.00%', remaining: '0.00%' });
    expect(
      screen.getByRole('img', {
        name: '$0.00 used, $0.00 committed, $0.00 remaining of $0.00',
      }),
    ).toBeTruthy();
  });

  it('says by how much an overrun budget is over', () => {
    render(<MandateMeter budget={usd('500000')} used={usd('400000')} committed={usd('200000')} />);
    expect(
      screen.getByRole('img', {
        name: '$4,000.00 used, $2,000.00 committed, $0.00 remaining of $5,000.00, $1,000.00 over',
      }),
    ).toBeTruthy();
  });

  it('shows each amount exactly, in the mono face, with a plain label', () => {
    const { container } = render(
      <MandateMeter
        budget={money('2000000', 'NGN')}
        used={money('500000', 'NGN')}
        committed={money('0', 'NGN')}
      />,
    );
    const legend = container.querySelector('[data-slot="mandate-meter-legend"]');
    expect(legend?.textContent).toContain('Used');
    expect(legend?.textContent).toContain('Committed');
    expect(legend?.textContent).toContain('Remaining');
    const values = [...container.querySelectorAll('[data-slot="amount-value"]')].map(
      (node) => node.textContent,
    );
    expect(values).toEqual(['₦20,000.00', '₦5,000.00', '₦0.00', '₦15,000.00']);
  });

  it('is a bar, not a gauge: one horizontal SVG with no arcs', () => {
    const { container } = render(
      <MandateMeter budget={usd('500000')} used={usd('120000')} committed={usd('30000')} />,
    );
    const svg = container.querySelector('svg[data-slot="mandate-meter-bar"]');
    expect(svg).not.toBeNull();
    expect(svg?.querySelector('path, circle')).toBeNull();
  });

  it('tells committed apart by pattern as well as colour', () => {
    const { container } = render(
      <MandateMeter budget={usd('500000')} used={usd('120000')} committed={usd('30000')} />,
    );
    const committed = container.querySelector('[data-segment="committed"]');
    expect(committed?.getAttribute('fill')).toMatch(/^url\(#/);
  });
});
