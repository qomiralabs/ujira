// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { themeBase, themeModes, themeType } from './defaults.generated.js';
import { declarations, hostTheme, typeStep } from './theme.js';

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const parts = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (parts === null) throw new Error(`not a hex colour: ${hex}`);
  const [r, g, b] = [1, 2, 3].map((index) => channel(Number.parseInt(parts[index] ?? '', 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG 2.2 contrast ratio, rounded down to two places. */
export function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return Math.floor(ratio * 100) / 100;
}

const MODES = ['light', 'dark'] as const;

describe('theme', () => {
  it('ships both modes with the same property names', () => {
    expect(Object.keys(themeModes.light)).toEqual(Object.keys(themeModes.dark));
  });

  it('puts every default on the host element', () => {
    const text = hostTheme.cssText;
    for (const [name, value] of Object.entries({ ...themeBase, ...themeModes.light })) {
      expect(text).toContain(`${name}: ${value};`);
    }
    expect(text).toContain(":host([mode='dark'])");
    expect(text).toContain('prefers-color-scheme: dark');
    expect(text).toContain(themeModes.dark['--ujira-embed-bg']);
  });

  it('refuses a property that is not ours', () => {
    expect(() => declarations({ '--brand-colour': 'red' })).toThrow('not an embed custom property');
  });

  it('refuses a value that could close the declaration', () => {
    expect(() => declarations({ '--ujira-embed-bg': 'red; display: none' })).toThrow(
      'a value CSS cannot take',
    );
    expect(() => declarations({ '--ujira-embed-bg': 'red /* comment' })).toThrow(
      'a value CSS cannot take',
    );
  });

  it('writes a type step out in full', () => {
    const text = typeStep('title').cssText;
    expect(text).toContain(`font-size: ${themeType.title.size}`);
    expect(text).toContain(`font-weight: ${themeType.title.weight}`);
    expect(text).toContain('font-family: var(--ujira-embed-font)');
  });

  it('keeps amounts, codes and labels in the mono face', () => {
    expect(themeType.data.family).toBe('var(--ujira-embed-font-mono)');
    expect(themeType.label.family).toBe('var(--ujira-embed-font-mono)');
  });

  it('keeps body line height at 1.6 or more for stacked diacritics', () => {
    expect(Number(themeType.body.lineHeight)).toBeGreaterThanOrEqual(1.6);
  });

  it('holds every colour pair the widget draws to WCAG AA', () => {
    for (const mode of MODES) {
      const tokens = themeModes[mode];
      const surface = tokens['--ujira-embed-surface'];
      expect(contrast(tokens['--ujira-embed-text'], surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['--ujira-embed-text-secondary'], surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['--ujira-embed-accent-text'], surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['--ujira-embed-error'], surface)).toBeGreaterThanOrEqual(4.5);
      // The action's label on the saffron fill.
      expect(
        contrast(tokens['--ujira-embed-on-accent'], tokens['--ujira-embed-accent']),
      ).toBeGreaterThanOrEqual(4.5);
      // Non text contrast: the edge of an input or a choice.
      expect(contrast(tokens['--ujira-embed-field-border'], surface)).toBeGreaterThanOrEqual(3);
    }
  });
});
