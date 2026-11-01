// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The Stellar SDK, with its RPC and Horizon clients, arrives with the
// Stellar adapter. Until then the one chain package is the Stellar base
// library (XDR and keys, no network code), pinned exactly, and only the
// codecs and the test fakes may load it. Everything else imports nothing
// chain specific, so the public types cannot lean on a chain library.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isChainSdkModule } from './chain-modules.js';

const PACKAGE_DIR = path.resolve(import.meta.dirname, '..');
const SRC = path.join(PACKAGE_DIR, 'src');
const BASE_LIBRARY = '@stellar/stellar-base';
// Folders under src that may import the base library.
const BASE_LIBRARY_FOLDERS = ['codecs', 'testing'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.[cm]?tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('the package is SDK free', () => {
  it('declares only the Stellar base library, at an exact version, as a chain dependency', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;
    const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    const chain = fields.flatMap((field) =>
      Object.entries(manifest[field] ?? {})
        .filter(([name]) => isChainSdkModule(name))
        .map(([name, version]) => ({ field, name, version })),
    );
    // The same pattern the lint rule bans outside this package.
    expect(chain.map(({ field, name }) => `${field}:${name}`)).toEqual([
      `dependencies:${BASE_LIBRARY}`,
    ]);
    expect(chain[0]?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(manifest['dependencies'] ?? {})).toContain('zod');
  });

  it('imports nothing chain specific outside the codecs and the test fakes', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(5);
    // Relative paths stay inside the package: the codecs folder reaches its
    // parent, and nothing climbs higher.
    const allowed = /^(\.\/|\.\.\/(?!\.\.)|@ujira\/core$|zod$|node:|vitest$|fast-check$|eslint$)/;
    const bad: string[] = [];
    const baseUsers = new Set<string>();
    for (const file of files) {
      const folder = path.relative(SRC, file).split(path.sep)[0] ?? '';
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)) {
        const spec = match[1] ?? '';
        if (spec === BASE_LIBRARY && BASE_LIBRARY_FOLDERS.includes(folder)) {
          baseUsers.add(folder);
          continue;
        }
        if (!allowed.test(spec)) bad.push(`${path.relative(SRC, file)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
    // Both folders use it, so a stale entry in the list above is noticed.
    expect([...baseUsers].sort()).toEqual(BASE_LIBRARY_FOLDERS);
  });
});
