// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mandate and factory wasm the local network tests deploy. They are the bytes
// deployed on testnet, so a test that passes on the local network has run the code
// that is live there. The hashes below are the ones the testnet deployment
// recorded, so a copy that drifts from what is deployed fails here, offline.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const DIR = path.join(import.meta.dirname, '../../fixtures/contracts');

// deployments/testnet.json in qomiralabs/ujira-contracts, mandate_wasm_hash and
// factory_wasm_hash.
const DEPLOYED = {
  'ujira_mandate.wasm': '47c93c212957b859995331ba0f1683b4f6dcb04802d51a378e8eaa3131fef61a',
  'ujira_factory.wasm': '4ec32aca58ed53ccf4f7ca74818f765d5b0aeaafd169c4335c6eb69b22804361',
};

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface Manifest {
  readonly commit: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

describe('the vendored contract wasm', () => {
  const manifest = JSON.parse(readFileSync(path.join(DIR, 'SOURCE.json'), 'utf8')) as Manifest;

  it('is what the testnet deployment recorded, byte for byte', () => {
    expect(manifest.files.map((f) => f.path).sort()).toEqual(Object.keys(DEPLOYED).sort());
    for (const file of manifest.files) {
      const bytes = readFileSync(path.join(DIR, file.path));
      expect(sha256(bytes), file.path).toBe(file.sha256);
      expect(file.sha256, file.path).toBe(DEPLOYED[file.path as keyof typeof DEPLOYED]);
    }
  });

  it('names the commit it was built from', () => {
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
