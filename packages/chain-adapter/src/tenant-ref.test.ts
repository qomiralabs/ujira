// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { InvalidInputError } from './errors.js';
import { addressXdr } from './stellar/address-xdr.js';
import { tenantRefOf, tenantTagOf } from './tenant-ref.js';
import type { Bytes32, TenantScope, Uuid } from './types.js';

const scope = (principalId: string, projectId: string): TenantScope => ({
  principalId: principalId as Uuid,
  projectId: projectId as Uuid,
});

describe('tenantTagOf', () => {
  // The worked example the contracts publish with the derivation.
  const reference = tenantRefOf(
    scope('0b2f3c1e-6a4d-4e8b-9c71-5d2a8f3e4b10', '7c9e2a41-3b8f-4d6c-a1e5-92f04b7d8c33'),
  );
  const mandate = 'CDUKSTCG3XKTPTHMNRJZIW23J3T5DKHASDPQ3CIRKQ4YJH3PDOFFULZA';

  it('matches the published worked example', () => {
    expect(reference).toBe('0xb9f99412a39e190d3fd7c4401d98c5d8c94acae7612d698335ed637039fe6dee');
    expect(Buffer.from(addressXdr(mandate)).toString('hex')).toBe(
      '0000001200000001e8a94c46ddd537ccec6c53945b5b4ee7d1a8e090df0d89115439849f6f1b8a5a',
    );
    expect(tenantTagOf(reference, addressXdr(mandate))).toBe(
      '0x2fff3250f540e461e527ed738e3436117a83261d8c9d9ea10f6262dff8c6e447',
    );
  });

  it('is the example the vendored encoding document states', () => {
    const encoding = readFileSync(
      path.resolve(import.meta.dirname, '../vendor/attestation-parity/ENCODING.md'),
      'utf8',
    );
    expect(encoding).toContain(`| \`tenant_ref\` | \`${reference.slice(2)}\` |`);
    const tag = tenantTagOf(reference, addressXdr(mandate));
    expect(encoding).toContain(`| \`tenant_tag\` | \`${tag.slice(2)}\` |`);
  });

  it('gives two mandates of one tenant unrelated tags', () => {
    const other = 'CAAVOGDGGM7JOLDS3CIQNPGSJOYFI54CJSAQQEFQKW7CES5UYIAZOYUQ';
    expect(tenantTagOf(reference, addressXdr(other))).not.toBe(
      tenantTagOf(reference, addressXdr(mandate)),
    );
  });

  it('refuses a reference that is not 32 bytes of lowercase hex', () => {
    expect(() => tenantTagOf('0x12' as Bytes32, addressXdr(mandate))).toThrow(InvalidInputError);
    expect(() => tenantTagOf(7 as unknown as Bytes32, addressXdr(mandate))).toThrow(
      InvalidInputError,
    );
  });
});

describe('tenantRefOf', () => {
  it('hashes the domain tag and the two UUIDs as raw bytes', () => {
    // Computed separately with Python's hashlib over the same layout, and
    // equal to the tenant reference the testnet mandate in the read
    // fixture stores for this scope.
    expect(
      tenantRefOf(
        scope('e6bece78-d0a1-4a41-8588-73a258cf8011', 'b4557662-6345-4196-ac9d-6da5f6c08a9e'),
      ),
    ).toBe('0xe88431e7d8de147f0a668ba5fa61b90e79472afdd4044879df398ca57b49dea4');
  });

  it('reads UUIDs in either letter case and keeps principal and project apart', () => {
    const a = '6f1c2a5e-0b7d-4c1e-9a3f-2d4e5f6a7b8c';
    const b = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    expect(tenantRefOf(scope(a.toUpperCase(), b))).toBe(tenantRefOf(scope(a, b)));
    expect(tenantRefOf(scope(a, b))).not.toBe(tenantRefOf(scope(b, a)));
  });

  it('refuses anything that is not a UUID', () => {
    expect(() => tenantRefOf(scope('not-a-uuid', '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'))).toThrow(
      InvalidInputError,
    );
    expect(() =>
      tenantRefOf(scope('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 42 as unknown as string)),
    ).toThrow(InvalidInputError);
  });
});
