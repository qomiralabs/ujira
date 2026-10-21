// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Turns the shared design tokens and the vendored brand mark into the two
// generated modules the widget ships. Everything here is pure apart from
// loadSources, so the tests run the same code the build script runs and
// compare the result with what is committed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { focus, fonts, modes, motion, palette, radius, typeScale } from '@ujira/ui';
import { format, resolveConfig } from 'prettier';

export const OUTPUT_FILES = [
  'src/theme/defaults.generated.ts',
  'src/brand/mark.generated.ts',
] as const;

export type OutputFile = (typeof OUTPUT_FILES)[number];

export const MARK_FILE = 'assets/brand/ujira_mark_primary_ink.svg';

const LICENSE_HEADER = [
  '// Copyright (c) 2026 Qomira Labs. All rights reserved.',
  '// Proprietary and confidential. Unauthorized copying is prohibited.',
].join('\n');

const NOTICE =
  'Generated from the @ujira/ui design tokens and the brand mark in assets/brand.\n' +
  'Do not edit by hand. Run `pnpm --filter @ujira/embed brand` to regenerate.';

/**
 * Custom properties that do not change with the colour mode. An integrator
 * overrides any of them on the element or on one of its ancestors.
 */
export function baseProperties(): Record<string, string> {
  return {
    '--ujira-embed-font': fonts.sans.stack,
    '--ujira-embed-font-mono': fonts.mono.stack,
    '--ujira-embed-radius-control': radius.control,
    '--ujira-embed-radius-card': radius.card,
    '--ujira-embed-focus-width': focus.width,
    '--ujira-embed-focus-offset': focus.offset,
    '--ujira-embed-focus': focus.color,
    '--ujira-embed-focus-inner': focus.inner,
    '--ujira-embed-ease': motion['ease-out'],
  };
}

/**
 * Colour properties per mode. Light leads: the widget sits on a recipient
 * screen. Text on the accent fill is teal ink in both modes, because the
 * accent fill is light in both.
 *
 * Every property here must be painted by something in the stylesheet. A
 * property an integrator can set that changes nothing is a promise the
 * widget cannot keep, and theme.test.ts fails if one stops being painted.
 */
export function modeProperties(mode: 'light' | 'dark'): Record<string, string> {
  const tokens = modes[mode];
  return {
    '--ujira-embed-surface': tokens.surface,
    '--ujira-embed-rule': tokens.rule,
    // Inputs and choices need a 3:1 edge against the surface, which the hair
    // line rule does not give, so they take the subtle text colour.
    '--ujira-embed-field-border': tokens['text-subtle'],
    '--ujira-embed-text': tokens.text,
    '--ujira-embed-text-secondary': tokens['text-secondary'],
    '--ujira-embed-accent': tokens.accent,
    // The hover fill is the brand's saffron lift, not a mix. A runtime mix
    // toward the text colour lands outside the palette, lands differently in
    // each mode, and moves when an integrator sets their own text colour,
    // which is a property they are invited to set and have no reason to
    // connect to the hover of an accent they never touched.
    '--ujira-embed-accent-hover': palette['saffron-lift'],
    // The colour of text links, back and change. It takes the body text
    // colour, not the brand's saffron text colour: saffron marks the one
    // thing to do, and these controls go backwards. Measured against the
    // surface, this is 15.07 in light and 8.90 in dark, against 5.78 and
    // 5.88 for the saffron it replaced.
    '--ujira-embed-link': tokens.text,
    '--ujira-embed-on-accent': palette['teal-ink'],
    '--ujira-embed-error': tokens.blocked,
  };
}

/** The type steps the widget uses, in CSS ready units. */
export function typeSteps(): Record<string, Record<string, string>> {
  const steps = ['title', 'body', 'body-s', 'data', 'label'] as const;
  const out: Record<string, Record<string, string>> = {};
  for (const name of steps) {
    const step = typeScale[name];
    out[name] = {
      family: step.family === 'mono' ? 'var(--ujira-embed-font-mono)' : 'var(--ujira-embed-font)',
      size: `${String(step.size)}px`,
      lineHeight: String(step.lineHeight),
      tracking: step.tracking,
      weight: String(step.weight),
    };
  }
  return out;
}

function renderRecord(entries: Record<string, string>, indent: string): string {
  return Object.entries(entries)
    .map(([key, value]) => `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join('\n');
}

function renderSteps(steps: Record<string, Record<string, string>>): string {
  return Object.entries(steps)
    .map(([name, step]) => `  ${JSON.stringify(name)}: {\n${renderRecord(step, '    ')}\n  },`)
    .join('\n');
}

export function renderDefaultsTs(): string {
  const light = renderRecord(modeProperties('light'), '    ');
  const dark = renderRecord(modeProperties('dark'), '    ');
  return `${LICENSE_HEADER}

${NOTICE.split('\n')
  .map((line) => `// ${line}`)
  .join('\n')}

/** Custom properties that are the same in every colour mode. */
export const themeBase = {
${renderRecord(baseProperties(), '  ')}
} as const;

/** Colour properties per mode. The light mode is the default. */
export const themeModes = {
  light: {
${light}
  },
  dark: {
${dark}
  },
} as const;

/** A colour mode the widget can render in. */
export type ThemeMode = keyof typeof themeModes;

/** Type steps, with the family already pointing at the themed font property. */
export const themeType = {
${renderSteps(typeSteps())}
} as const;
`;
}

interface Mark {
  viewBox: string;
  shapes: string;
}

const COLOUR = /(?:fill|stroke)="(#[0-9A-Fa-f]{6})"/g;
const ALLOWED_ELEMENTS = /^(?:path|circle)$/;
const ELEMENT = /<\s*([a-zA-Z][\w-]*)/g;

/**
 * Reads the vendored one colour mark. The artwork is never redrawn: the
 * shapes are copied as they are and the single ink colour becomes
 * currentColor, which is how an embedded component shows the mark in the
 * integrator's own neutral text colour.
 */
export function parseMark(svgSource: string): Mark {
  const viewBox = /viewBox="([^"]+)"/.exec(svgSource)?.[1];
  if (viewBox === undefined) throw new Error('the mark has no viewBox');
  const open = svgSource.indexOf('>');
  const close = svgSource.lastIndexOf('</svg>');
  if (open === -1 || close === -1 || close < open) throw new Error('the mark has no <svg> element');
  const inner = svgSource.slice(open + 1, close).trim();
  const colours = new Set(
    [...inner.matchAll(COLOUR)].map((match) => match[1]?.toUpperCase() ?? ''),
  );
  if (colours.size !== 1) {
    throw new Error(`the mark must use exactly one colour, found ${String(colours.size)}`);
  }
  const ink = [...colours][0] ?? '';
  if (ink !== palette['teal-ink'].toUpperCase()) {
    throw new Error(`the mark colour ${ink} is not the teal ink token`);
  }
  for (const [, element] of inner.matchAll(ELEMENT)) {
    if (element !== undefined && !ALLOWED_ELEMENTS.test(element)) {
      throw new Error(`the mark holds an unexpected element: ${element}`);
    }
  }
  return {
    viewBox,
    shapes: inner.replaceAll(COLOUR, (match) => match.replace(ink, 'currentColor')),
  };
}

export function renderMarkTs(mark: Mark): string {
  return `${LICENSE_HEADER}

${NOTICE.split('\n')
  .map((line) => `// ${line}`)
  .join('\n')}

import { svg, type SVGTemplateResult } from 'lit';

/** The coordinate system the mark is drawn in. */
export const markViewBox = '${mark.viewBox}';

/**
 * The mark as supplied, in currentColor so it takes the colour of the text
 * next to it. Never redraw it, never set a colour on it here.
 */
export const markShapes: SVGTemplateResult = svg\`${mark.shapes}\`;
`;
}

export interface Sources {
  mark: string;
}

export function loadSources(root: string): Sources {
  return { mark: readFileSync(join(root, MARK_FILE), 'utf8') };
}

/** Every output file, formatted with the repository Prettier config. */
export async function generateOutputs(root: string): Promise<Record<OutputFile, string>> {
  const sources = loadSources(root);
  const raw: Record<OutputFile, string> = {
    'src/theme/defaults.generated.ts': renderDefaultsTs(),
    'src/brand/mark.generated.ts': renderMarkTs(parseMark(sources.mark)),
  };
  const formatted = {} as Record<OutputFile, string>;
  for (const file of OUTPUT_FILES) {
    const filepath = join(root, file);
    const config = (await resolveConfig(filepath)) ?? {};
    formatted[file] = await format(raw[file], { ...config, filepath });
  }
  return formatted;
}
