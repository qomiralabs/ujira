// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { themeBase, themeModes, themeType } from './defaults.generated.js';
import { widgetStyles } from './styles.js';
import { declarations, hostTheme, registerFocusProperties, typeStep } from './theme.js';

/**
 * The CSS declarations each property is spent in. A property used in more
 * than one declaration has more than one effect, and its row in the README
 * describes one of them.
 */
function effects(): Map<string, Set<string>> {
  const css = widgetStyles.map((sheet) => sheet.cssText).join('\n');
  const found = new Map<string, Set<string>>();
  for (const chunk of css.split(/[;{}]/)) {
    const colon = chunk.indexOf(':');
    if (colon === -1) continue;
    const property = (chunk.slice(0, colon).trim().split('\n').pop() ?? '').trim();
    for (const use of chunk.slice(colon + 1).matchAll(/var\((--ujira-embed-[a-z-]+)/g)) {
      const name = use[1] ?? '';
      found.set(name, (found.get(name) ?? new Set()).add(property));
    }
  }
  return found;
}

/**
 * Properties known to do more than one thing, each with the reason. This is
 * an acknowledgement list, not a ban: one of these is three declarations
 * doing a single job, so outlawing multiple uses would be wrong and would
 * get suppressed, which is worse than no rule.
 *
 * What it buys is narrower than it looks and worth having for that: it
 * cannot check whether a description is accurate, only whether someone
 * noticed there were two effects to describe. The sentence they then write
 * stays prose, and stays a convention.
 */
const KNOWN_MULTI_EFFECT: Readonly<Record<string, string>> = {
  // The problem message and its border: one job, two declarations.
  '--ujira-embed-error': 'border, color',
  // Every hair line in the card: one job, three declarations.
  '--ujira-embed-rule': 'border, border-bottom, border-top',
  // Headings and answers, and the three marks on a chosen payout method:
  // the dot, the border and the inner ring.
  '--ujira-embed-text': 'accent-color, border-color, box-shadow, color',
};

/** Every custom property the stylesheet actually reads. */
function painted(): Set<string> {
  const css = widgetStyles.map((sheet) => sheet.cssText).join('\n');
  return new Set([...css.matchAll(/var\((--ujira-embed-[a-z-]+)/g)].map((m) => m[1] ?? ''));
}

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
    expect(Object.keys(themeModes.light).length).toBe(10);
  });

  it('puts every default on the host element', () => {
    const text = hostTheme.cssText;
    for (const [name, value] of Object.entries({ ...themeBase, ...themeModes.light })) {
      expect(text).toContain(`${name}: ${value};`);
    }
    expect(text).toContain(":host([mode='dark'])");
    expect(text).toContain('prefers-color-scheme: dark');
    expect(text).toContain(themeModes.dark['--ujira-embed-surface']);
  });

  // A property an integrator can set that changes nothing is a promise the
  // widget cannot keep, and the README documents every one of them. This is
  // the test that found --ujira-embed-bg, which was documented as the ground
  // behind the card and painted by nothing, because that ground belongs to
  // the integrator's page.
  it('paints with every property the contract offers', () => {
    const uses = painted();
    // Dark as well as light: the two carry the same keys, which the test
    // above pins, but a property added to one and not the other would
    // otherwise be offered, undocumented and invisible to this.
    const declared = [
      ...Object.keys(themeBase),
      ...new Set([...Object.keys(themeModes.light), ...Object.keys(themeModes.dark)]),
    ];
    // Names the offender first, then pins the count so a derivation that
    // found nothing cannot pass in silence.
    expect(declared.filter((name) => !uses.has(name))).toEqual([]);
    expect(declared.length).toBe(20);
    expect(uses.size).toBe(20);
  });

  // The painted test checks code against code. This checks the code against
  // what an integrator is told, which is the other half of the same promise:
  // a property they can set and cannot find, or find and cannot set, is the
  // documentation misleading them. It was added because the property that
  // introduced the painted rule was itself left undocumented.
  it('documents every property it offers, and offers every one it documents', () => {
    const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8');
    const documented = [...readme.matchAll(/^\| `(--ujira-embed-[a-z-]+)`/gm)].map((m) => m[1]);
    const declared = [...Object.keys(themeBase), ...Object.keys(themeModes.light)];
    expect([...documented].sort()).toEqual([...declared].sort());
    expect(documented.length).toBe(20);
  });

  it('offers every property the stylesheet reads', () => {
    const declared = new Set([...Object.keys(themeBase), ...Object.keys(themeModes.light)]);
    expect([...painted()].filter((name) => !declared.has(name))).toEqual([]);
  });

  it('knows which properties do more than one thing', () => {
    const multi = [...effects()]
      .filter(([, declarations]) => declarations.size > 1)
      .map(([name, declarations]) => [name, [...declarations].sort().join(', ')] as const);
    expect(Object.fromEntries(multi)).toEqual(KNOWN_MULTI_EFFECT);
  });

  /*
   * A stand in, and a blunt one. What protects the chosen method's shape
   * signal is that the control keeps its native appearance: the appearance
   * property is not inherited, so a host page cannot reach it through the
   * shadow boundary, which puts the empty circle becoming a filled one
   * outside the theming surface entirely. That protection lasts exactly as
   * long as nobody writes `appearance: none` on this rule to restyle the
   * radio, and nothing would catch that, because appearance is not a custom
   * property and so never appears in the effects derivation.
   *
   * The assertion that belongs here reads the computed appearance of the
   * rendered control in a browser. It cannot be written yet, because the
   * choices block renders only when more than one payout method is open.
   * Replace this with that one when they open, rather than keeping a
   * strange negative test.
   */
  it('leaves the choice control its native appearance', () => {
    // The whole sheet, not the one rule: slicing to a rule passes when the
    // selector is renamed, which is what the person this guards against
    // would do, and misses the same declaration in a later rule or in a
    // blanket reset. If a legitimate use ever arrives this becomes an
    // allowlist of one, which is still better than a slice.
    // Comments stripped first: the guard is about declarations, and prose
    // saying the word is not one. It caught its own comment before this.
    const css = widgetStyles
      .map((sheet) => sheet.cssText)
      .join('\n')
      .replaceAll(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toContain('.choice input');
    expect(css).not.toMatch(/\bappearance\s*:/);
  });

  it('refuses a property that is not ours', () => {
    expect(() => declarations({ '--brand-colour': 'red' })).toThrow('not an embed custom property');
  });

  it('refuses a value that could close the declaration', () => {
    expect(() => declarations({ '--ujira-embed-surface': 'red; display: none' })).toThrow(
      'a value CSS cannot take',
    );
    expect(() => declarations({ '--ujira-embed-surface': 'red /* comment' })).toThrow(
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

  // Two layers so the ring survives any ground: saffron carries it on the
  // dark surface, the ink band carries it on the light one, and on the
  // action's own saffron fill the band is the only one that can. The
  // property is that one of the pair reaches 3:1 on every ground, never
  // that both do.
  it('keeps the focus ring visible on every ground it lands on', () => {
    for (const mode of MODES) {
      const tokens = themeModes[mode];
      const ring = themeBase['--ujira-embed-focus'];
      const band = themeBase['--ujira-embed-focus-inner'];
      for (const ground of [tokens['--ujira-embed-surface'], tokens['--ujira-embed-accent']]) {
        const best = Math.max(contrast(ring, ground), contrast(band, ground));
        expect(
          best,
          `neither ring layer is visible on ${ground} in ${mode}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('holds every colour pair the widget draws to WCAG AA', () => {
    for (const mode of MODES) {
      const tokens = themeModes[mode];
      const surface = tokens['--ujira-embed-surface'];
      expect(contrast(tokens['--ujira-embed-text'], surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['--ujira-embed-text-secondary'], surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['--ujira-embed-link'], surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['--ujira-embed-error'], surface)).toBeGreaterThanOrEqual(4.5);
      // The action's label on the saffron fill.
      expect(
        contrast(tokens['--ujira-embed-on-accent'], tokens['--ujira-embed-accent']),
      ).toBeGreaterThanOrEqual(4.5);
      // Links are the body text colour, not saffron: saffron marks the one
      // thing to do and these go backwards. Measured, not asserted loosely.
      expect(contrast(tokens['--ujira-embed-link'], surface)).toBe(mode === 'light' ? 15.07 : 8.9);
      // The hover fill is a brand value, not a runtime mix, so it holds its
      // contrast with the label and does not move with the text colour.
      expect(
        contrast(tokens['--ujira-embed-on-accent'], tokens['--ujira-embed-accent-hover']),
      ).toBeGreaterThanOrEqual(4.5);
      // Non text contrast: the edge of an input or a choice.
      expect(contrast(tokens['--ujira-embed-field-border'], surface)).toBeGreaterThanOrEqual(3);
    }
  });
});

interface Definition {
  name: string;
  syntax: string;
  inherits: boolean;
  initialValue: string;
}

/** A registry that records what it is given and can be told to throw. */
function fakeRegistry(fail?: (name: string) => Error | undefined): {
  registry: { registerProperty: (definition: Definition) => void };
  registered: Definition[];
} {
  const registered: Definition[] = [];
  return {
    registered,
    registry: {
      registerProperty(definition) {
        const error = fail?.(definition.name);
        if (error !== undefined) throw error;
        registered.push(definition);
      },
    },
  };
}

/** Every custom property the :focus-visible rule reads. */
function focusRuleProperties(): Set<string> {
  const css = widgetStyles.map((sheet) => sheet.cssText).join('\n');
  const rule = /:focus-visible\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  return new Set([...rule.matchAll(/var\((--ujira-embed-[a-z-]+)/g)].map((m) => m[1] ?? ''));
}

describe('registerFocusProperties', () => {
  it('registers every property the focus rule reads, and nothing else', () => {
    const { registry, registered } = fakeRegistry();
    registerFocusProperties(registry);
    const names = registered.map(({ name }) => name).sort();
    expect(names).toEqual([...focusRuleProperties()].sort());
    expect(names).toHaveLength(5);
  });

  it('types each one, inherits it, and starts it at the generated default', () => {
    const { registry, registered } = fakeRegistry();
    registerFocusProperties(registry);
    for (const { name, syntax, inherits, initialValue } of registered) {
      expect(syntax).toBe(
        name.endsWith('-width') || name.endsWith('-offset') ? '<length>' : '<color>',
      );
      expect(inherits).toBe(true);
      expect(initialValue).toBe(themeBase[name as keyof typeof themeBase]);
    }
  });

  it('carries on past a name that is registered already', () => {
    const taken = '--ujira-embed-focus';
    const { registry, registered } = fakeRegistry((name) =>
      name === taken ? new DOMException('registered', 'InvalidModificationError') : undefined,
    );
    expect(() => {
      registerFocusProperties(registry);
    }).not.toThrow();
    expect(registered.map(({ name }) => name)).not.toContain(taken);
    expect(registered).toHaveLength(4);
  });

  it('rethrows anything else, so a bad definition is not hidden', () => {
    const { registry } = fakeRegistry(() => new DOMException('bad initial value', 'SyntaxError'));
    expect(() => {
      registerFocusProperties(registry);
    }).toThrow('bad initial value');
  });

  it('does nothing where the browser cannot register properties', () => {
    expect(() => {
      registerFocusProperties({});
    }).not.toThrow();
  });
});
