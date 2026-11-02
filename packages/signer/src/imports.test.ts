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

// The HTTP server loads only in the service folder, so a caller that imports
// RemoteSigner from the package root never loads a server.
const SERVICE_ONLY = new Set([
  'hono',
  'hono/body-limit',
  '@hono/node-server',
  'node:http',
  'node:net',
]);

function inService(file: string): boolean {
  return path.relative(SRC, file).startsWith(`service${path.sep}`);
}

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
        const service = inService(file);
        const relative = spec.startsWith('./') || (service && spec.startsWith('../'));
        const allowed = SHIPPED.has(spec) || (service && SERVICE_ONLY.has(spec));
        // Outside the service folder nothing reaches into it.
        const intoService = !service && /(^|\/)service(\/|$)/.test(spec);
        if ((!relative && !allowed) || intoService) {
          bad.push(`${path.relative(SRC, file)}: ${spec}`);
        }
      }
      expect(text).not.toMatch(/\bimport\s*\(/);
    }
    expect(bad).toEqual([]);
  });
});
