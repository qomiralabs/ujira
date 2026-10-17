// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import * as generated from '../src/tokens/tokens.generated.js';
import {
  contrastRatio,
  generateOutputs,
  loadSources,
  OUTPUT_FILES,
  parseBrandTokens,
  parseSprite,
  parseSystemTokens,
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

function must(value: string | undefined): string {
  if (value === undefined) throw new Error('missing token');
  return value;
}

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
  Object.entries(brand.modes[mode])
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

  it('rejects more than four categorical colours', () => {
    const broken = structuredClone(systemJson) as { viz: { dark: { categorical: string[] } } };
    broken.viz.dark.categorical.push('#5C8F9A');
    expect(() => parseSystemTokens(broken)).toThrow();
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
  });

  it('carry every light mode colour exactly', () => {
    const light = rule(rules, LIGHT);
    for (const key of modeColourKeys('light')) {
      expect(light[`--ujira-${key}`], key).toBe(brand.modes.light[key]);
    }
  });

  it('carry every dark mode colour exactly, for the system setting and the manual toggle', () => {
    for (const selector of [DARK_MEDIA, DARK]) {
      const dark = rule(rules, selector);
      for (const key of modeColourKeys('dark')) {
        expect(dark[`--ujira-${key}`], `${selector} ${key}`).toBe(brand.modes.dark[key]);
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
    expect(light['--ujira-viz-sequential-5']).toBe(brand.core['teal']);
    expect(dark['--ujira-viz-categorical-1']).toBe(brand.core['cream']);
    expect(dark['--ujira-viz-sequential-1']).toBe(brand.core['teal']);
    expect(light['--ujira-viz-highlight']).toBe(brand.core['saffron']);
    expect(light['--ujira-viz-grid']).toBe(brand.modes.light['rule']);
    expect(dark['--ujira-viz-grid']).toBe(brand.modes.dark['rule']);
    expect(dark['--ujira-viz-axis']).toBe(brand.modes.dark['text-secondary']);
    expect(dark['--ujira-viz-paid']).toBe(brand.status['paid']?.dark);
  });

  it('shrink rows under the compact density', () => {
    expect(rule(rules, ':root')['--ujira-row-height']).toBe('44px');
    expect(rule(rules, "[data-density='compact']")['--ujira-row-height']).toBe('36px');
  });
});

describe('TypeScript constants', () => {
  it('equal the brand tokens', () => {
    expect(generated.palette).toEqual({ ...brand.core, ...brand.neutral });
    expect(generated.status).toEqual(brand.status);
    expect(generated.modes).toEqual(brand.modes);
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

  it('run the dark sequential scale toward cream', () => {
    expect([...generated.viz.dark.sequential]).toEqual(
      [...generated.viz.light.sequential].reverse(),
    );
  });

  it('carry the design system scale', () => {
    expect(generated.radius).toEqual({ control: '6px', card: '10px', overlay: '14px' });
    expect(generated.density).toEqual({ row: '44px', 'row-compact': '36px' });
    expect(generated.motion['ease-out']).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(generated.typeScale['display-s']).toMatchObject({ size: 28, weight: 800 });
    expect(generated.fonts.mono.face).toBe('JetBrains Mono');
  });
});

describe('Tailwind theme', () => {
  const require = createRequire(import.meta.url);

  async function build(candidates: string[]): Promise<string> {
    const compiler = await compile(
      "@import 'tailwindcss/theme.css';\n@import './theme.css';\n@tailwind utilities;",
      {
        base: join(PACKAGE_ROOT, 'styles'),
        loadStylesheet: (id, base) => {
          const path = id.startsWith('.') ? join(base, id) : require.resolve(id);
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

  it('produces utilities from the brand tokens', async () => {
    const css = await build([
      'bg-surface',
      'text-text-secondary',
      'border-rule',
      'bg-accent',
      'text-paid',
      'fill-viz-categorical-2',
      'rounded-card',
      'rounded-control',
      'font-mono',
      'font-display',
      'text-amount-xl',
      'h-row',
      'shadow-overlay',
      'ease-settle',
      'outline-focus',
    ]);
    // The theme is inline, so utilities read the mode variables directly.
    expect(css).toMatch(/\.bg-surface \{\s*background-color: var\(--ujira-surface\);/);
    expect(css).toMatch(/\.rounded-card \{\s*border-radius: var\(--ujira-radius-card\);/);
    expect(css).toMatch(/\.h-row \{\s*height: var\(--ujira-row-height\);/);
    expect(css).toMatch(/\.font-mono \{\s*font-family: var\(--ujira-font-mono\);/);
    expect(css).toMatch(/\.text-amount-xl \{\s*font-size: 2\.5rem;/);
    for (const utility of [
      '.text-text-secondary',
      '.border-rule',
      '.bg-accent',
      '.text-paid',
      '.fill-viz-categorical-2',
      '.rounded-card',
      '.rounded-control',
      '.font-mono',
      '.font-display',
      '.text-amount-xl',
      '.h-row',
      '.shadow-overlay',
      '.ease-settle',
      '.outline-focus',
    ]) {
      expect(css, utility).toContain(utility);
    }
  });

  it('drops the default palette, fonts and radii so only brand values exist', async () => {
    const css = await build(['bg-blue-500', 'font-serif', 'rounded-lg', 'shadow-xl', 'text-2xl']);
    expect(css).not.toMatch(/\.(bg-blue-500|font-serif|rounded-lg|shadow-xl|text-2xl)\b/);
  });
});

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it.each(['light', 'dark'] as const)('meets AA for text tokens in %s mode', (mode) => {
    const tokens = brand.modes[mode];
    for (const ground of ['bg', 'surface'] as const) {
      for (const text of ['text', 'text-secondary', 'text-subtle', 'accent-text'] as const) {
        const ratio = contrastRatio(must(tokens[text]), must(tokens[ground]));
        expect(ratio, `${text} on ${ground}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
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
});
