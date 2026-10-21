// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';
import { cn } from './cn.js';

describe('cn', () => {
  it('joins class names and drops falsy values', () => {
    expect(cn('a', false, undefined, null, 'b', { c: true, d: false })).toBe('a b c');
  });

  it('keeps a brand type step next to a brand text colour', () => {
    // Both start with text-, so an unconfigured merge would treat them as one
    // colour and drop the first.
    expect(cn('text-body-s', 'text-text-secondary')).toBe('text-body-s text-text-secondary');
    expect(cn('text-label', 'text-blocked')).toBe('text-label text-blocked');
  });

  it('lets a later brand colour replace an earlier one', () => {
    expect(cn('text-text', 'text-blocked')).toBe('text-blocked');
    expect(cn('bg-surface', 'bg-accent-fill')).toBe('bg-accent-fill');
    expect(cn('border-rule-strong', 'border-blocked')).toBe('border-blocked');
  });

  it('lets a later type step replace an earlier one', () => {
    expect(cn('text-body-s', 'text-body')).toBe('text-body');
  });

  it('treats the brand radii as one group', () => {
    expect(cn('rounded-control', 'rounded-card')).toBe('rounded-card');
  });
});
