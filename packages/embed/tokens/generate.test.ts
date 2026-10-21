// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fonts, modes, palette, radius } from '@ujira/ui';
import { describe, expect, it } from 'vitest';

import { themeBase, themeModes } from '../src/theme/defaults.generated.js';
import {
  baseProperties,
  generateOutputs,
  MARK_FILE,
  modeProperties,
  OUTPUT_FILES,
  parseMark,
  typeSteps,
} from './generate.ts';

const PACKAGE_ROOT = join(import.meta.dirname, '..');
const markSource = readFileSync(join(PACKAGE_ROOT, MARK_FILE), 'utf8');

describe('generated brand files', () => {
  it('match what is committed', async () => {
    const outputs = await generateOutputs(PACKAGE_ROOT);
    for (const file of OUTPUT_FILES) {
      const committed = readFileSync(join(PACKAGE_ROOT, file), 'utf8');
      expect(committed, `${file} is out of date, run pnpm --filter @ujira/embed brand`).toBe(
        outputs[file],
      );
    }
  });

  it('take every colour from the shared tokens, never a typed in hex', () => {
    expect(themeModes.light['--ujira-embed-surface']).toBe(modes.light.surface);
    expect(themeModes.dark['--ujira-embed-surface']).toBe(modes.dark.surface);
    expect(themeModes.light['--ujira-embed-link']).toBe(modes.light.text);
    expect(themeModes.dark['--ujira-embed-link']).toBe(modes.dark.text);
    expect(themeModes.dark['--ujira-embed-on-accent']).toBe(palette['teal-ink']);
    expect(themeBase['--ujira-embed-radius-card']).toBe(radius.card);
    expect(modeProperties('light')).toEqual(themeModes.light);
    expect(baseProperties()).toEqual(themeBase);
  });

  it('takes both font stacks from the shared tokens, verbatim', () => {
    expect(themeBase['--ujira-embed-font']).toBe(fonts.sans.stack);
    // The mono stack names the second face that draws the naira, cedi, peso
    // and rupee signs. The widget never draws an amount, so it never needs
    // those glyphs, and it loads no font of its own: the stack falls through
    // to whatever the host page has. It is taken as it comes rather than
    // trimmed here, so the widget cannot drift from the shared token.
    expect(themeBase['--ujira-embed-font-mono']).toBe(fonts.mono.stack);
    expect(fonts.mono.stack).toContain(fonts.mono.signs.face);
  });

  it('name every custom property with the embed prefix', () => {
    const names = [
      ...Object.keys(baseProperties()),
      ...Object.keys(modeProperties('light')),
      ...Object.keys(modeProperties('dark')),
    ];
    for (const name of names) {
      expect(name).toMatch(/^--ujira-embed-[a-z-]+$/);
    }
  });

  it('keeps the two modes on the same property names', () => {
    expect(Object.keys(modeProperties('light'))).toEqual(Object.keys(modeProperties('dark')));
  });

  it('carries the type steps the widget draws with', () => {
    expect(Object.keys(typeSteps())).toEqual(['title', 'body', 'body-s', 'data', 'label']);
  });
});

describe('the brand mark', () => {
  it('is copied as supplied and recoloured only to currentColor', () => {
    const mark = parseMark(markSource);
    expect(mark.viewBox).toBe('0 0 100 100');
    expect(mark.shapes).toContain('stroke="currentColor"');
    expect(mark.shapes).toContain('fill="currentColor"');
    expect(mark.shapes).not.toContain(palette['teal-ink']);
    // The geometry is untouched: the same path, the same coin.
    expect(mark.shapes).toContain('M34 46C30 38 22 32 14 32C14 56 30 68 50 68');
    expect(mark.shapes).toContain('<circle cx="50" cy="40" r="11"');
  });

  it('refuses a mark with no viewBox', () => {
    expect(() => parseMark('<svg><path fill="#0B2A33" /></svg>')).toThrow('no viewBox');
  });

  it('refuses a mark drawn in more than one colour', () => {
    const two = markSource.replace('#0B2A33"></circle>', '#F4A300"></circle>');
    expect(() => parseMark(two)).toThrow('exactly one colour');
  });

  it('refuses a mark that is not in the brand ink', () => {
    const wrong = markSource.replaceAll('#0B2A33', '#123456');
    expect(() => parseMark(wrong)).toThrow('is not the teal ink token');
  });

  it('refuses anything in the file that is not artwork', () => {
    const tampered = markSource.replace('<circle', '<script></script><circle');
    expect(() => parseMark(tampered)).toThrow('unexpected element');
  });
});
