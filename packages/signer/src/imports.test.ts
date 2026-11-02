// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The signer holds signing permission, so what its shipped code can load is
// kept short: node:crypto, the ed25519 library, zod, the chain adapter's
// port types and its pure codecs subpath. In particular it never loads the
// adapter's test fakes or a chain library directly, which the repository's
// lint already refuses everywhere outside the adapter. Tests and the
// conformance suite, which never ship, may also load vitest and the fakes.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(import.meta.dirname);

const SHIPPED = new Set([
  'node:crypto',
  '@noble/curves/ed25519.js',
  'zod',
  '@ujira/chain-adapter',
  '@ujira/chain-adapter/codecs',
]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

function isShipped(file: string): boolean {
  const relative = path.relative(SRC, file);
  return !/\.test(-d)?\.ts$/.test(relative) && !relative.startsWith(`testing${path.sep}`);
}

describe('the signer imports', () => {
  it('ship nothing but the crypto, the schema library and the adapter port and codecs', () => {
    const shipped = files(SRC).filter(isShipped);
    expect(shipped.length).toBeGreaterThan(5);
    const bad: string[] = [];
    for (const file of shipped) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)) {
        const spec = match[1] ?? '';
        if (!spec.startsWith('./') && !SHIPPED.has(spec)) {
          bad.push(`${path.relative(SRC, file)}: ${spec}`);
        }
      }
      expect(text).not.toMatch(/\bimport\s*\(/);
    }
    expect(bad).toEqual([]);
  });
});
