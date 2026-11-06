// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { typeScale } from '../tokens/index.js';

const HERE = import.meta.dirname;
const THEME_CSS = join(HERE, '..', '..', 'styles', 'theme.css');

// The primitives, and every other folder of components that draws colour.
const COMPONENT_DIRS = [
  HERE,
  join(HERE, '..', 'money'),
  join(HERE, '..', 'payments'),
  join(HERE, '..', 'patterns'),
  join(HERE, '..', 'patterns', 'data-table'),
];

const sources = COMPONENT_DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter(
      (file) => /\.tsx?$/.test(file) && !file.includes('.test.') && !file.includes('.test-d.'),
    )
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') })),
);

const RAW_COLOUR = [/#[0-9a-f]{3,8}\b/gi, /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi];

/** Hex values and colour functions written into the text. */
function rawColours(text: string): string[] {
  return RAW_COLOUR.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0]));
}

const themeColours = new Set(
  [...readFileSync(THEME_CSS, 'utf8').matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]),
);

// Suffixes of colour prefixes that are not colours.
// Text alignment (text-start, text-end) and table borders (border-separate,
// border-collapse, border-spacing-0) share the colour prefixes too.
const NOT_COLOURS = new Set([
  ...Object.keys(typeScale),
  'transparent',
  'left',
  'center',
  'right',
  'start',
  'end',
  'justify',
  'separate',
  'collapse',
]);
const NOT_COLOUR_PREFIX = /^(?:offset|none|hidden|solid|dashed|dotted|spacing)/;
// A per edge border width such as border-r-2 or border-y-0, and a bare edge
// such as border-x: widths, not colours.
const EDGE_WIDTH = /^[xytrbl](?:-\d+(?:\.\d+)?)?$/;
const COLOUR_UTILITY = /(?<![\w-])(?:bg|text|border|outline|ring|fill|stroke)-([a-z][a-z0-9-]*)/g;

/**
 * Colour utilities whose colour is not in the brand theme. Arbitrary values
 * in brackets are skipped here; rawColours checks what is inside them.
 */
function unknownColours(text: string): string[] {
  return [...text.replace(/\[[^\]]*\]/g, '').matchAll(COLOUR_UTILITY)]
    .map((match) => match[1] ?? '')
    .filter(
      (name) => !NOT_COLOURS.has(name) && !NOT_COLOUR_PREFIX.test(name) && !EDGE_WIDTH.test(name),
    )
    .filter((name) => !themeColours.has(name));
}

/** Custom properties read in arbitrary values that are not UJIRA or Radix ones. */
function foreignVariables(text: string): string[] {
  return [...text.matchAll(/var\((--[a-z0-9-]+)|-\((--[a-z0-9-]+)\)/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((name) => !/^--(?:ujira|radix)-/.test(name));
}

describe('no raw colours', () => {
  it('finds the patterns it is meant to catch', () => {
    expect(rawColours('bg-[#F4A300] text-[rgb(0_0_0)] fill-[oklch(0.7_0.1_80)]')).toHaveLength(3);
    expect(unknownColours('bg-red-500 text-body-s text-text')).toEqual(['red-500']);
    expect(unknownColours('transition-[color,border-color]')).toEqual([]);
    expect(unknownColours('border-r-2 border-y-0 border-x border-2 border-dashed')).toEqual([]);
    expect(unknownColours('border-r-2 border-fuchsia-500')).toEqual(['fuchsia-500']);
    expect(unknownColours('text-start text-end border-separate border-spacing-0')).toEqual([]);
    expect(unknownColours('text-end-500 border-spacious')).toEqual(['end-500', 'spacious']);
    expect(foreignVariables('bg-(--tw-foo) bg-(--ujira-saffron-lift)')).toEqual(['--tw-foo']);
  });

  it('primitives contain no hex, rgb or hsl literals', () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const { file, text } of sources) expect(rawColours(text), file).toEqual([]);
  });

  it('primitives only use colours from the brand theme', () => {
    expect(themeColours.size).toBeGreaterThan(0);
    for (const { file, text } of sources) {
      expect(unknownColours(text), file).toEqual([]);
      expect(foreignVariables(text), file).toEqual([]);
    }
  });
});
