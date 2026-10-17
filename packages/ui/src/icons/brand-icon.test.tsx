// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { BrandIcon, brandIconNames, type BrandIconName } from './index.js';

afterEach(cleanup);

const NINE = [
  'mandate',
  'payout',
  'recipient',
  'approval',
  'receipt',
  'rail',
  'local-currency',
  'agent',
  'pause',
] as const;

describe('brandIconNames', () => {
  it('lists the nine brand icons in sprite order', () => {
    expect(brandIconNames).toEqual(NINE);
  });

  it('types the name as exactly the nine icons', () => {
    expectTypeOf<BrandIconName>().toEqualTypeOf<(typeof NINE)[number]>();
    // @ts-expect-error an unknown name does not compile
    const unknown = <BrandIcon name="wallet" />;
    expect(unknown).toBeTruthy();
  });
});

describe('BrandIcon', () => {
  it.each(NINE)('draws %s on the 24px grid with currentColor strokes', (name) => {
    const { container } = render(<BrandIcon name={name} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('stroke-width')).toBe('1.5');
    expect(svg?.getAttribute('stroke-linecap')).toBe('round');
    expect(svg?.getAttribute('stroke-linejoin')).toBe('round');
    expect(svg?.getAttribute('fill')).toBe('none');
    expect(svg?.dataset['icon']).toBe(name);
    expect(svg?.children.length).toBeGreaterThan(0);
    for (const shape of svg?.querySelectorAll('*') ?? []) {
      expect(shape.getAttribute('fill'), `${name} ${shape.tagName}`).toBeNull();
      expect(shape.getAttribute('stroke'), `${name} ${shape.tagName}`).toBeNull();
    }
  });

  it('is hidden from assistive technology when it has no label', () => {
    const { container } = render(<BrandIcon name="payout" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
    expect(svg?.getAttribute('role')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('is an image named by its label when it has one', () => {
    render(<BrandIcon name="approval" label="Waiting for approval" />);
    const img = screen.getByRole('img', { name: 'Waiting for approval' });
    expect(img.getAttribute('aria-hidden')).toBeNull();
  });

  it('defaults to 24px and takes a size', () => {
    const { container, rerender } = render(<BrandIcon name="rail" />);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('24');
    expect(container.querySelector('svg')?.getAttribute('height')).toBe('24');
    rerender(<BrandIcon name="rail" size={16} />);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('16');
    expect(container.querySelector('svg')?.getAttribute('height')).toBe('16');
  });

  it('passes through a class name and other SVG props', () => {
    const { container } = render(
      <BrandIcon name="receipt" className="text-accent" data-testid="receipt-icon" />,
    );
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')).toBe('text-accent');
    expect(svg?.dataset['testid']).toBe('receipt-icon');
  });

  it('keeps the brand stroke even when stroke props are passed', () => {
    const { container } = render(
      <BrandIcon
        name="mandate"
        {...({ stroke: 'red', strokeWidth: 3 } as Record<string, unknown>)}
      />,
    );
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('stroke-width')).toBe('1.5');
  });
});
