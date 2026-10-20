// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { render } from '@testing-library/react';
import { Wallet } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { Icon } from './icon';

describe('Icon', () => {
  // The brand draws on a 24px grid with a 1.5px stroke. An icon rendered
  // smaller must keep that stroke rather than scale it down with the box,
  // which the non scaling vector effect pins on every shape.
  function keepsBrandStroke(svg: SVGElement | null): boolean {
    if (svg?.getAttribute('stroke-width') !== '1.5') return false;
    const shapes = [...svg.querySelectorAll('path, circle, rect, line, polyline')];
    return (
      shapes.length > 0 &&
      shapes.every((shape) => shape.getAttribute('vector-effect') === 'non-scaling-stroke')
    );
  }

  it('draws Lucide at 24 by default with a 1.5px round stroke, hidden from assistive technology', () => {
    const { container } = render(<Icon source={{ lucide: Wallet }} className="x" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('24');
    expect(keepsBrandStroke(svg)).toBe(true);
    expect(svg?.getAttribute('stroke-linecap')).toBe('round');
    expect(svg?.getAttribute('stroke-linejoin')).toBe('round');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('class')).toContain('x');
  });

  it.each([16, 20, 24])('keeps the stroke at 1.5px when drawn at %spx', (size) => {
    const { container } = render(<Icon source={{ lucide: Wallet }} size={size} />);
    expect(keepsBrandStroke(container.querySelector('svg'))).toBe(true);
  });

  it('draws a brand icon from the sprite shapes', () => {
    const { container } = render(<Icon source={{ brand: 'payout' }} size={24} />);
    const svg = container.querySelector('svg');
    expect(svg?.dataset['icon']).toBe('payout');
    expect(svg?.getAttribute('stroke-width')).toBe('1.5');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('width')).toBe('24');
  });
});
