// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import * as generated from '../src/tokens/tokens.generated.js';
import { ciede2000, colourDifference, contrastRatio, VISION } from './colour.ts';
import {
  cssString,
  generateOutputs,
  loadSources,
  OUTPUT_FILES,
  parseBrandTokens,
  parseSprite,
  parseSystemTokens,
  renderTokensCss,
  resolveTokens,
} from './generate.ts';

const PACKAGE_ROOT = join(import.meta.dirname, '..');
const HEX = /#[0-9a-f]{6}\b/gi;

const brandJson = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'assets/brand/Tokens.json'), 'utf8'),
) as Record<string, unknown>;
const systemJson = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'tokens/system.json'), 'utf8'),
) as Record<string, unknown>;
const brand = parseBrandTokens(brandJson);

function brandStatus(name: string): { fill: string; text: string; dark: string } {
  const found = brand.status[name];
  if (!found) throw new Error(`no status ${name}`);
  return found;
}

// The design system adds mode fill tokens for each status and replaces one
// brand value: dark blocked text, which is 3.44:1 on the dark surface in the
// brand file. The brand red stays as the dark blocked fill and icon colour.
const DARK_BLOCKED_TEXT = '#FCA5A5';
const expectedModes: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    ...brand.modes.light,
    'paid-fill': brandStatus('paid').fill,
    'waiting-fill': brandStatus('waiting').fill,
    'blocked-fill': brandStatus('blocked').fill,
  },
  dark: {
    ...brand.modes.dark,
    blocked: DARK_BLOCKED_TEXT,
    'paid-fill': brandStatus('paid').dark,
    'waiting-fill': brandStatus('waiting').dark,
    'blocked-fill': brandStatus('blocked').dark,
  },
};

function read(relativePath: string): string {
  return readFileSync(join(PACKAGE_ROOT, relativePath), 'utf8');
}

type Declarations = Record<string, string>;

// Collects the custom property declarations of every rule, keyed by the full
// selector path, so `@media (prefers-color-scheme: dark) > :root:not(...)` is
// told apart from `[data-theme='dark']`. Comments are dropped first.
function cssRules(css: string): Map<string, Declarations> {
  const rules = new Map<string, Declarations>();
  const stack: string[] = [];
  let buffer = '';
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (char === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '));
      buffer = '';
    } else if (char === '}') {
      collect(buffer);
      stack.pop();
      buffer = '';
    } else if (char === ';') {
      collect(buffer);
      buffer = '';
    } else {
      buffer += char;
    }
  }
  function collect(text: string): void {
    const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(text);
    if (!match?.[1] || match[2] === undefined) return;
    const key = stack.join(' > ');
    const declarations = rules.get(key) ?? {};
    // Prettier lowercases hex colours in CSS; compare them as the brand writes them.
    declarations[match[1]] = /^#[0-9a-f]{6}$/i.test(match[2]) ? match[2].toUpperCase() : match[2];
    rules.set(key, declarations);
  }
  return rules;
}

function rule(rules: Map<string, Declarations>, selector: string): Declarations {
  const found = rules.get(selector);
  if (!found) throw new Error(`no rule for ${selector}, have: ${[...rules.keys()].join(' | ')}`);
  return found;
}

const LIGHT = ":root, [data-theme='light']";
const DARK_MEDIA = "@media (prefers-color-scheme: dark) > :root:not([data-theme='light'])";
const DARK = "[data-theme='dark']";

const modeColourKeys = (mode: 'light' | 'dark'): string[] =>
  Object.entries(expectedModes[mode])
    .filter(([, value]) => value.startsWith('#'))
    .map(([key]) => key);

describe('committed outputs', () => {
  it('lists every generated file', () => {
    expect([...OUTPUT_FILES].sort()).toEqual([
      'src/icons/brand-icons.generated.ts',
      'src/tokens/tokens.generated.ts',
      'styles/theme.css',
      'styles/tokens.css',
    ]);
  });

  it('match a fresh generation from the brand sources', async () => {
    const outputs = await generateOutputs(PACKAGE_ROOT);
    for (const file of OUTPUT_FILES) {
      expect(read(file), `${file} is stale, run pnpm --filter @ujira/ui tokens`).toBe(
        outputs[file],
      );
    }
  });

  it('only contain hex values from the brand tokens or the data visualisation literals', () => {
    const allowed = new Set(
      [...JSON.stringify(brandJson).matchAll(HEX), ...JSON.stringify(systemJson).matchAll(HEX)].map(
        (m) => m[0].toUpperCase(),
      ),
    );
    for (const file of OUTPUT_FILES) {
      for (const match of read(file).matchAll(HEX)) {
        expect(allowed, `${match[0]} in ${file}`).toContain(match[0].toUpperCase());
      }
    }
  });
});

describe('design system source', () => {
  it('never retypes a brand colour as a literal', () => {
    const brandHex = new Set([...JSON.stringify(brandJson).matchAll(HEX)].map((m) => m[0]));
    for (const match of JSON.stringify(systemJson).matchAll(HEX)) {
      expect(brandHex, `${match[0]} should be a reference`).not.toContain(match[0].toUpperCase());
    }
  });

  it('rejects a reference that does not exist', () => {
    const broken = structuredClone(systemJson) as { viz: { light: { highlight: string } } };
    broken.viz.light.highlight = '{core.gold}';
    expect(() => resolveTokens(brand, parseSystemTokens(broken))).toThrow(/core\.gold/);
  });

  it('rejects a malformed literal colour', () => {
    const broken = structuredClone(systemJson) as { viz: { light: { categorical: string[] } } };
    broken.viz.light.categorical[1] = '#5C8F9';
    expect(() => parseSystemTokens(broken)).toThrow();
  });

  it('rejects mode additions that differ between light and dark', () => {
    const broken = structuredClone(systemJson) as { mode: { dark: Record<string, string> } };
    delete broken.mode.dark['paid-fill'];
    expect(() => parseSystemTokens(broken)).toThrow(/same keys/);
  });

  it('rejects a mode addition that refers to another mode token', () => {
    const broken = structuredClone(systemJson) as { mode: { light: Record<string, string> } };
    broken.mode.light['paid-fill'] = '{mode.paid}';
    expect(() => parseSystemTokens(broken)).toThrow(/mode token/);
  });

  it('rejects a status addition that replaces a brand shade', () => {
    const broken = structuredClone(systemJson) as {
      status: Record<string, Record<string, string>>;
    };
    broken.status['blocked'] = { dark: '#FCA5A5' };
    expect(() => resolveTokens(brand, parseSystemTokens(broken))).toThrow(/already exists/);
  });

  it('rejects a status addition for a status the brand does not have', () => {
    const broken = structuredClone(systemJson) as {
      status: Record<string, Record<string, string>>;
    };
    broken.status['refunded'] = { text: '#FCA5A5' };
    expect(() => resolveTokens(brand, parseSystemTokens(broken))).toThrow(/does not exist/);
  });

  it('rejects more than four categorical colours', () => {
    const broken = structuredClone(systemJson) as { viz: { dark: { categorical: string[] } } };
    broken.viz.dark.categorical.push('#5C8F9A');
    expect(() => parseSystemTokens(broken)).toThrow();
  });
});

describe('font family names', () => {
  function withFace(face: string): unknown {
    const changed = structuredClone(systemJson) as { font: { sans: { face: string } } };
    changed.font.sans.face = face;
    return changed;
  }

  it('rejects a face that breaks out of the CSS string', () => {
    expect(() => parseSystemTokens(withFace("Inter'), url(https://example.invalid/x"))).toThrow(
      /font family name/,
    );
  });

  it.each([
    ['a double quote', 'Inter"'],
    ['a backslash', 'Inter\\27'],
    ['a newline', 'Inter\nx'],
    ['a semicolon', 'Inter;'],
    ['a brace', 'Inter}'],
    ['a comment opener', 'Inter/*'],
    ['a leading space', ' Inter'],
    ['a trailing space', 'Inter '],
    ['two spaces in a row', 'Inter  Tight'],
    ['a name over 64 characters', 'A'.repeat(65)],
    ['an empty name', ''],
  ])('rejects a face with %s', (_name, face) => {
    expect(() => parseSystemTokens(withFace(face))).toThrow(/font family name/);
  });

  it.each(['Inter', 'JetBrains Mono', 'Noto Sans-Display', 'Font 2', 'A'.repeat(64)])(
    'accepts %s',
    (face) => {
      expect(parseSystemTokens(withFace(face)).font.sans.face).toBe(face);
    },
  );

  it('quotes and escapes CSS strings', () => {
    expect(cssString('Inter')).toBe("'Inter'");
    expect(cssString("a'b")).toBe("'a\\27 b'");
    expect(cssString('a\\b')).toBe("'a\\5c b'");
    expect(cssString('a"b\nc')).toBe("'a\\22 b\\a c'");
  });

  it('escapes the face in the CSS even if validation is bypassed', () => {
    const system = parseSystemTokens(systemJson);
    const crafted = "Inter'), url(https://example.invalid/x";
    const css = renderTokensCss(
      resolveTokens(brand, {
        ...system,
        font: { ...system.font, sans: { ...system.font.sans, face: crafted } },
      }),
    );
    const sans = rule(cssRules(css), ':root')['--ujira-font-sans'];
    expect(sans).toBe(
      "var(--ujira-font-inter, 'Inter\\27 ), url(https://example.invalid/x'), ui-sans-serif, system-ui, sans-serif",
    );
  });
});

describe('brand tokens parsing', () => {
  it('rejects a mode whose keys differ from the other mode', () => {
    const broken = structuredClone(brandJson) as { modes: { dark: Record<string, string> } };
    delete broken.modes.dark['rule-strong'];
    expect(() => parseBrandTokens(broken)).toThrow(/rule-strong/);
  });

  it('rejects a colour that is not a six digit hex', () => {
    const broken = structuredClone(brandJson) as { core: Record<string, string> };
    broken.core['teal'] = 'teal';
    expect(() => parseBrandTokens(broken)).toThrow();
  });
});

describe('CSS custom properties', () => {
  const rules = cssRules(read('styles/tokens.css'));

  it('carry every core, neutral and status colour exactly', () => {
    const root = rule(rules, ':root');
    for (const [name, hex] of Object.entries(brand.core)) {
      expect(root[`--ujira-${name}`], name).toBe(hex);
    }
    for (const [name, hex] of Object.entries(brand.neutral)) {
      expect(root[`--ujira-${name}`], name).toBe(hex);
    }
    for (const [name, shades] of Object.entries(brand.status)) {
      for (const [shade, hex] of Object.entries(shades)) {
        expect(root[`--ujira-status-${name}-${shade}`], `${name} ${shade}`).toBe(hex);
      }
    }
    expect(root['--ujira-status-blocked-dark-text']).toBe(DARK_BLOCKED_TEXT);
  });

  it('keep every brand mode value except dark blocked text', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const [key, value] of Object.entries(brand.modes[mode])) {
        const expected = mode === 'dark' && key === 'blocked' ? DARK_BLOCKED_TEXT : value;
        expect(generated.modes[mode][key as keyof typeof generated.modes.light], key).toBe(
          expected,
        );
      }
    }
    expect(brand.modes.dark['blocked']).toBe(brandStatus('blocked').dark);
    expect(generated.modes.dark['blocked-fill']).toBe(brandStatus('blocked').dark);
  });

  it('draw a saffron focus ring around a teal ink inner ring', () => {
    const root = rule(rules, ':root');
    expect(root['--ujira-focus-ring-color']).toBe(brand.core['saffron']);
    expect(root['--ujira-focus-ring-inner']).toBe(brand.core['teal-ink']);
    const css = read('styles/tokens.css');
    expect(css).toMatch(
      /:focus-visible \{\s*outline: var\(--ujira-focus-ring-width\) solid var\(--ujira-focus-ring-color\);\s*outline-offset: var\(--ujira-focus-ring-offset\);\s*box-shadow: 0 0 0 var\(--ujira-focus-ring-offset\) var\(--ujira-focus-ring-inner\);/,
    );
  });

  it('carry every light mode colour exactly', () => {
    const light = rule(rules, LIGHT);
    for (const key of modeColourKeys('light')) {
      expect(light[`--ujira-${key}`], key).toBe(expectedModes.light[key]);
    }
  });

  it('carry every dark mode colour exactly, for the system setting and the manual toggle', () => {
    for (const selector of [DARK_MEDIA, DARK]) {
      const dark = rule(rules, selector);
      for (const key of modeColourKeys('dark')) {
        expect(dark[`--ujira-${key}`], `${selector} ${key}`).toBe(expectedModes.dark[key]);
      }
    }
  });

  it('have identical keys in light and dark', () => {
    const light = Object.keys(rule(rules, LIGHT)).sort();
    expect(light.length).toBeGreaterThan(modeColourKeys('light').length);
    expect(Object.keys(rule(rules, DARK_MEDIA)).sort()).toEqual(light);
    expect(Object.keys(rule(rules, DARK)).sort()).toEqual(light);
    expect(rule(rules, DARK_MEDIA)).toEqual(rule(rules, DARK));
  });

  it('carry the data visualisation palette per mode', () => {
    const light = rule(rules, LIGHT);
    const dark = rule(rules, DARK);
    expect(light['--ujira-viz-categorical-1']).toBe(brand.core['teal']);
    expect(light['--ujira-viz-sequential-4']).toBe(brand.core['teal']);
    expect(light['--ujira-viz-sequential-5']).toBe(brand.core['teal-ink']);
    expect(dark['--ujira-viz-categorical-1']).toBe(brand.core['cream']);
    expect(dark['--ujira-viz-categorical-2']).toBe(brand.neutral['mist-300']);
    expect(dark['--ujira-viz-sequential-5']).toBe(brand.core['cream']);
    expect(light['--ujira-viz-highlight']).toBe(brand.core['saffron']);
    expect(dark['--ujira-viz-highlight']).toBe(brand.core['saffron']);
    expect(light['--ujira-viz-highlight-stroke']).toBe(brand.core['saffron-deep']);
    expect(dark['--ujira-viz-highlight-stroke']).toBe(brand.core['saffron']);
    expect(light['--ujira-viz-waiting-stroke']).toBe(brandStatus('waiting').text);
    expect(dark['--ujira-viz-waiting-stroke']).toBe(brandStatus('waiting').dark);
    expect(light['--ujira-viz-grid']).toBe(brand.modes.light['rule']);
    expect(dark['--ujira-viz-grid']).toBe(brand.modes.dark['rule']);
    expect(dark['--ujira-viz-axis']).toBe(brand.modes.dark['text-secondary']);
    expect(dark['--ujira-viz-paid']).toBe(brandStatus('paid').dark);
  });

  it('shrink rows under the compact density', () => {
    expect(rule(rules, ':root')['--ujira-row-height']).toBe('44px');
    expect(rule(rules, "[data-density='compact']")['--ujira-row-height']).toBe('36px');
  });
});

describe('TypeScript constants', () => {
  it('equal the brand tokens', () => {
    expect(generated.palette).toEqual({ ...brand.core, ...brand.neutral });
    expect(generated.status).toEqual({
      ...brand.status,
      blocked: { ...brandStatus('blocked'), 'dark-text': DARK_BLOCKED_TEXT },
    });
    expect(generated.modes).toEqual(expectedModes);
    expect(generated.focus).toMatchObject({
      color: brand.core['saffron'],
      inner: brand.core['teal-ink'],
    });
  });

  it('have identical keys in light and dark', () => {
    expect(Object.keys(generated.modes.dark).sort()).toEqual(
      Object.keys(generated.modes.light).sort(),
    );
    expect(Object.keys(generated.viz.dark).sort()).toEqual(Object.keys(generated.viz.light).sort());
    expect(generated.viz.dark.categorical).toHaveLength(4);
    expect(generated.viz.light.categorical).toHaveLength(4);
    expect(generated.viz.dark.sequential).toHaveLength(5);
    expect(generated.viz.light.sequential).toHaveLength(5);
  });

  it.each(['light', 'dark'] as const)(
    'step the %s sequential scale away from the surface',
    (mode) => {
      const surface = generated.modes[mode].surface;
      const ratios = generated.viz[mode].sequential.map((step) => contrastRatio(step, surface));
      expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
      expect(new Set(ratios).size).toBe(ratios.length);
    },
  );

  it('carry the design system scale', () => {
    expect(generated.radius).toEqual({ control: '6px', card: '10px', overlay: '14px' });
    expect(generated.density).toEqual({ row: '44px', 'row-compact': '36px' });
    expect(generated.motion['ease-out']).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(generated.typeScale['display-s']).toMatchObject({ size: 28, weight: 800 });
    expect(generated.fonts.mono.face).toBe('JetBrains Mono');
  });
});

describe('Tailwind theme', () => {
  async function build(candidates: string[]): Promise<string> {
    const compiler = await compile(
      "@import 'tailwindcss/theme.css';\n@import './theme.css';\n@tailwind utilities;",
      {
        base: join(PACKAGE_ROOT, 'styles'),
        loadStylesheet: (id, base) => {
          const path = id.startsWith('.') ? join(base, id) : fileURLToPath(import.meta.resolve(id));
          return Promise.resolve({
            path,
            base: dirname(path),
            content: readFileSync(path, 'utf8'),
          });
        },
      },
    );
    return compiler.build(candidates);
  }

  const UTILITIES = [
    'bg-surface',
    'text-text-secondary',
    'border-rule',
    'bg-accent-fill',
    'text-accent-text',
    'text-paid',
    'bg-blocked-fill',
    'fill-viz-categorical-2',
    'stroke-viz-highlight-stroke',
    'rounded-card',
    'rounded-control',
    'font-mono',
    'font-display',
    'text-amount-xl',
    'h-row',
    'shadow-overlay',
    'ease-settle',
    'outline-focus',
    'ring-focus-inner',
  ];

  it('produces utilities from the brand tokens', async () => {
    const css = await build(UTILITIES);
    // The theme is inline, so utilities read the mode variables directly.
    expect(css).toMatch(/\.bg-surface \{\s*background-color: var\(--ujira-surface\);/);
    expect(css).toMatch(/\.bg-accent-fill \{\s*background-color: var\(--ujira-accent\);/);
    expect(css).toMatch(/\.rounded-card \{\s*border-radius: var\(--ujira-radius-card\);/);
    expect(css).toMatch(/\.h-row \{\s*height: var\(--ujira-row-height\);/);
    expect(css).toMatch(/\.font-mono \{\s*font-family: var\(--ujira-font-mono\);/);
    expect(css).toMatch(/\.text-amount-xl \{\s*font-size: 2\.5rem;/);
    for (const utility of UTILITIES) {
      expect(css, utility).toContain(`.${utility} {`);
    }
  });

  it('drops the default palette, fonts and radii so only brand values exist', async () => {
    const css = await build(['bg-blue-500', 'font-serif', 'rounded-lg', 'shadow-xl', 'text-2xl']);
    expect(css).not.toMatch(/\.(bg-blue-500|font-serif|rounded-lg|shadow-xl|text-2xl)\b/);
  });

  it('cannot produce saffron text or a status colour that ignores the mode', async () => {
    const banned = [
      'text-accent',
      'bg-accent',
      'text-saffron',
      'bg-saffron',
      'text-saffron-deep',
      'text-saffron-lift',
      'bg-status-paid-dark',
      'text-status-blocked-dark',
      'text-status-blocked-dark-text',
      'bg-status-waiting-fill',
    ];
    const css = await build(banned);
    for (const utility of banned) {
      expect(css, utility).not.toContain(`.${utility} {`);
    }
    expect(read('styles/theme.css')).not.toMatch(/--color-(saffron|status-|accent:)/);
  });
});

const MODES = ['light', 'dark'] as const;
const GROUNDS = ['bg', 'surface'] as const;

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it.each(MODES)('meets AA for text and status text in %s mode', (mode) => {
    const tokens = generated.modes[mode];
    for (const ground of GROUNDS) {
      for (const text of [
        'text',
        'text-secondary',
        'text-subtle',
        'accent-text',
        'paid',
        'waiting',
        'blocked',
      ] as const) {
        const ratio = contrastRatio(tokens[text], tokens[ground]);
        expect(ratio, `${text} on ${ground}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(MODES)('keeps status fills and icons at 3:1 in %s mode', (mode) => {
    const tokens = generated.modes[mode];
    for (const ground of GROUNDS) {
      for (const fill of ['paid-fill', 'blocked-fill'] as const) {
        const ratio = contrastRatio(tokens[fill], tokens[ground]);
        expect(ratio, `${fill} on ${ground}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it.each(MODES)('keeps the focus ring at 3:1 in %s mode', (mode) => {
    const tokens = generated.modes[mode];
    const { color, inner } = generated.focus;
    // One of the two rings must stand out from the ground, and the rings must
    // stand out from each other so the ring shows on a saffron button too.
    for (const ground of GROUNDS) {
      const best = Math.max(
        contrastRatio(color, tokens[ground]),
        contrastRatio(inner, tokens[ground]),
      );
      expect(best, `focus ring on ${ground}: ${best.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(color, inner)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(inner, tokens.accent)).toBeGreaterThanOrEqual(3);
  });

  // The saffron highlight and the light waiting fill keep their colour and
  // carry contrast through their stroke tokens. Gridlines, the tooltip ground
  // and its rule are structure, not data marks.
  const VIZ_MARKS = [
    'highlight-stroke',
    'paid',
    'waiting-stroke',
    'blocked',
    'axis',
    'tooltip-text',
  ] as const;

  it.each(MODES)('keeps every data mark at 3:1 in %s mode', (mode) => {
    const tokens = generated.modes[mode];
    const viz = generated.viz[mode];
    const marks: [string, string][] = [
      ...viz.categorical.map((c, i): [string, string] => [`categorical ${String(i + 1)}`, c]),
      ...viz.sequential.map((c, i): [string, string] => [`sequential ${String(i + 1)}`, c]),
      ...VIZ_MARKS.map((key): [string, string] => [key, viz[key]]),
    ];
    for (const ground of GROUNDS) {
      for (const [name, colour] of marks) {
        const ratio = contrastRatio(colour, tokens[ground]);
        expect(ratio, `${name} on ${ground}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('exempts only the highlight fill and the light waiting fill among data fills', () => {
    const failing = MODES.flatMap((mode) =>
      (['highlight', 'waiting'] as const)
        .filter((key) =>
          GROUNDS.some(
            (ground) => contrastRatio(generated.viz[mode][key], generated.modes[mode][ground]) < 3,
          ),
        )
        .map((key) => `${mode} ${key}`),
    );
    expect(failing).toEqual(['light highlight', 'light waiting']);
  });
});

describe('colour vision', () => {
  it('matches the CIEDE2000 reference pairs', () => {
    // Sharma, Wu and Dalal (2005), table 1, pairs 1, 7 and 17.
    expect(ciede2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
    expect(ciede2000([50, 0, 0], [50, -1, 2])).toBeCloseTo(2.3669, 4);
    expect(ciede2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 4);
  });

  it('leaves a colour unchanged for normal vision', () => {
    expect(colourDifference('#0F4C5C', '#0F4C5C')).toBe(0);
    expect(colourDifference('#0F4C5C', '#0F4C5C', 'deuteranopia')).toBe(0);
  });

  function minimum(pairs: [string, string][]): { value: number; at: string } {
    let best = { value: Infinity, at: '' };
    for (const vision of VISION) {
      for (const [a, b] of pairs) {
        const value = colourDifference(a, b, vision);
        if (value < best.value) best = { value, at: `${a} and ${b} under ${vision}` };
      }
    }
    return best;
  }

  it.each(MODES)('keeps %s categorical colours at least 10 apart', (mode) => {
    const colours = generated.viz[mode].categorical;
    const pairs = colours.flatMap((a, i) =>
      colours.slice(i + 1).map((b): [string, string] => [a, b]),
    );
    const { value, at } = minimum(pairs);
    expect(value, `${value.toFixed(1)} for ${at}`).toBeGreaterThanOrEqual(10);
  });

  it.each(MODES)('keeps %s categorical colours at least 10 from the highlight', (mode) => {
    const viz = generated.viz[mode];
    const { value, at } = minimum(viz.categorical.map((c): [string, string] => [c, viz.highlight]));
    expect(value, `${value.toFixed(1)} for ${at}`).toBeGreaterThanOrEqual(10);
  });

  it.each(MODES)('keeps adjacent %s sequential steps at least 5 apart', (mode) => {
    const steps = generated.viz[mode].sequential;
    const { value, at } = minimum(
      steps.slice(1).map((s, i): [string, string] => [steps[i] ?? s, s]),
    );
    expect(value, `${value.toFixed(1)} for ${at}`).toBeGreaterThanOrEqual(5);
  });
});

describe('brand sprite', () => {
  const { sprite } = loadSources(PACKAGE_ROOT);

  it('holds exactly the nine brand icons', () => {
    expect(Object.keys(parseSprite(sprite))).toEqual([
      'mandate',
      'payout',
      'recipient',
      'approval',
      'receipt',
      'rail',
      'local-currency',
      'agent',
      'pause',
    ]);
  });

  it('keeps the 24px grid and the 1.5px round stroke', () => {
    const tampered = sprite.replace('stroke-width="1.5"', 'stroke-width="2"');
    expect(() => parseSprite(tampered)).toThrow(/stroke-width/);
  });

  it('rejects a fill on an icon shape', () => {
    const tampered = sprite.replace('<circle cx="19"', '<circle fill="red" cx="19"');
    expect(() => parseSprite(tampered)).toThrow(/fill/);
  });

  it('ships without embedded provenance metadata', () => {
    expect(sprite).not.toMatch(/c2pa|<metadata|jumb|anVtY/i);
  });

  it('keeps every brand kit shape byte for byte', () => {
    // SHA-256 of the brand kit symbols, joined by newlines. Only the
    // metadata element and its namespace were removed from the copy.
    const symbols = sprite.match(/<symbol\b[\s\S]*?<\/symbol>/g) ?? [];
    expect(symbols).toHaveLength(9);
    expect(createHash('sha256').update(symbols.join('\n')).digest('hex')).toBe(
      'daed34937eff8cc6095600f85098ce9643aca8c77e7febdebda536b54b988534',
    );
    expect(sprite).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n${symbols.join('\n')}\n</svg>`,
    );
  });
});
