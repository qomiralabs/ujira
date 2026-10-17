// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, expectTypeOf, it } from 'vitest';
import * as ui from '../index.js';
import { cssVar, type ColorMode, type ModeToken } from './index.js';

describe('token exports', () => {
  it('names the CSS custom property of a token', () => {
    expect(cssVar('surface')).toBe('var(--ujira-surface)');
    expect(cssVar('viz-categorical-1')).toBe('var(--ujira-viz-categorical-1)');
  });

  it('types the colour modes and their shared token names', () => {
    expectTypeOf<ColorMode>().toEqualTypeOf<'light' | 'dark'>();
    expectTypeOf<ModeToken>().toEqualTypeOf<keyof typeof ui.modes.dark>();
  });

  it('exposes tokens and icons from the package entry', () => {
    expect(Object.keys(ui).sort()).toEqual([
      'BrandIcon',
      'brandIconNames',
      'cssVar',
      'density',
      'focus',
      'fonts',
      'modes',
      'motion',
      'palette',
      'radius',
      'shadow',
      'status',
      'typeScale',
      'viz',
    ]);
  });
});
