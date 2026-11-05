// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The visual baselines hold only if every build draws text with the same font files.
// Downloading them at build time broke that: the same commit built with different
// files, and letter spacing moved enough to fail screenshots at random. So the files
// come from a package the lockfile pins, and these tests hold that in place.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = import.meta.dirname;
const layout = readFileSync(join(here, 'layout.tsx'), 'utf8');
const globals = readFileSync(join(here, 'globals.css'), 'utf8');

const paths = [...layout.matchAll(/src: '([^']+\.woff2)'/g)].map((match) => match[1] ?? '');

// A change here changes how text renders, so it needs the baselines rendered again
// with apps/dashboard/scripts/e2e-linux.sh --update.
const PINNED: Readonly<Record<string, string>> = {
  'inter-latin-wght-normal.woff2':
    '3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62',
  'inter-latin-ext-wght-normal.woff2':
    '34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956',
  'jetbrains-mono-latin-wght-normal.woff2':
    '18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e',
  'jetbrains-mono-latin-ext-wght-normal.woff2':
    '79bfdab9ba467e26eea4122e6f2567e188dd8a09a8c730d501fc487c4ab99c6e',
};

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The unicode range the package itself declares for a file. */
function packageRange(path: string): string {
  const css = readFileSync(join(dirname(resolve(here, path)), '..', 'wght.css'), 'utf8');
  const name = basename(path).replace('.woff2', '');
  const block = css.slice(css.indexOf(`/* ${name} */`));
  const range = /unicode-range: ([^;]+);/.exec(block)?.[1];
  if (range === undefined) throw new Error(`the package declares no range for ${name}`);
  return range;
}

describe('the dashboard fonts', () => {
  it('fetches nothing at build time', () => {
    expect(layout).not.toContain('next/font/google');
    expect(layout).toContain("from 'next/font/local'");
  });

  it('loads each pinned file, and no other', () => {
    expect(paths.map(basename).sort()).toEqual(Object.keys(PINNED).sort());
  });

  it.each(Object.entries(PINNED))(
    '%s holds the bytes the baselines were rendered with',
    (file, sha) => {
      const path = paths.find((candidate) => basename(candidate) === file);
      if (path === undefined) throw new Error(`layout.tsx does not load ${file}`);
      const bytes = readFileSync(resolve(here, path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha);
    },
  );

  it('confines each file to the range its package declares', () => {
    for (const path of paths) {
      const at = layout.indexOf(path);
      const declared = /prop: 'unicode-range',\s+value:\s+'([^']+)'/.exec(layout.slice(at))?.[1];
      expect(declared, basename(path)).toBe(packageRange(path));
    }
  });

  it('keeps the weights the app has always asked for', () => {
    // A range wider than these would draw a weight no baseline has ever shown.
    expect(layout.match(/weight: '400 600'/g)).toHaveLength(2);
    expect(layout.match(/weight: '400 500'/g)).toHaveLength(2);
  });

  it('gives the tokens one stack for each family, with latin first', () => {
    expect(globals).toContain(
      '--ujira-font-inter: var(--ujira-font-inter-latin), var(--ujira-font-inter-latin-ext);',
    );
    expect(globals).toContain(
      '--ujira-font-jetbrains-mono:\n    var(--ujira-font-jetbrains-mono-latin), var(--ujira-font-jetbrains-mono-latin-ext);',
    );
  });

  it('sets those stacks outside any layer, where they cannot lose to the tokens', () => {
    const stack = globals.indexOf('--ujira-font-inter:');
    const layer = globals.indexOf('@layer');
    expect(stack).toBeGreaterThan(-1);
    expect(stack).toBeLessThan(layer);
  });

  it('leaves the metric fallback to the last family, so latin text falls through to it', () => {
    // Latin text has to reach the size adjusted fallback while its own face loads. A
    // fallback on the latin family would also catch the letters latin-ext draws.
    const latin = layout.slice(
      layout.indexOf('inter-latin-wght'),
      layout.indexOf('inter-latin-ext'),
    );
    expect(latin).toContain('adjustFontFallback: false');
    const ext = layout.slice(
      layout.indexOf('inter-latin-ext'),
      layout.indexOf('jetbrains-mono-latin-wght'),
    );
    expect(ext).not.toContain('adjustFontFallback: false');
  });
});
