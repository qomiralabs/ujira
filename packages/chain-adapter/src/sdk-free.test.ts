// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// This package ships the interface only. The Stellar SDK arrives with the
// Stellar adapter, so for now no chain SDK may be a dependency or an import,
// and the public types cannot lean on one.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isChainSdkModule } from './chain-modules.js';

const PACKAGE_DIR = path.resolve(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.[cm]?tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('the scaffold is SDK free', () => {
  it('declares no chain SDK dependency', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;
    const names = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ].flatMap((field) => Object.keys(manifest[field] ?? {}));
    // The same pattern the lint rule bans outside this package.
    expect(names.filter((name) => isChainSdkModule(name))).toEqual([]);
    expect(names).toContain('zod');
  });

  it('imports nothing but core, zod, node and its own modules', () => {
    const files = sourceFiles(path.join(PACKAGE_DIR, 'src'));
    expect(files.length).toBeGreaterThan(5);
    const allowed = /^(\.\/|@ujira\/core$|zod$|node:|vitest$|fast-check$|eslint$)/;
    const bad: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)) {
        const spec = match[1] ?? '';
        if (!allowed.test(spec)) bad.push(`${path.basename(file)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
