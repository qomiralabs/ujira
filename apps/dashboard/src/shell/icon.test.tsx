// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { render } from '@testing-library/react';
import { Wallet } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { Icon } from './icon';

describe('Icon', () => {
  it('draws Lucide on the brand grid: 1.5px round stroke, hidden from assistive technology', () => {
    const { container } = render(<Icon source={{ lucide: Wallet }} className="x" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('stroke-width')).toBe('1.5');
    expect(svg?.getAttribute('stroke-linecap')).toBe('round');
    expect(svg?.getAttribute('stroke-linejoin')).toBe('round');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.getAttribute('class')).toContain('x');
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
