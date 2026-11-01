// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { InvalidInputError } from './errors.js';
import { tenantRefOf } from './tenant-ref.js';
import type { TenantScope, Uuid } from './types.js';

const scope = (principalId: string, projectId: string): TenantScope => ({
  principalId: principalId as Uuid,
  projectId: projectId as Uuid,
});

describe('tenantRefOf', () => {
  it('hashes the domain tag and the two UUIDs as raw bytes', () => {
    // Computed separately with Python's hashlib over the same layout, and
    // equal to the tenant reference the testnet mandate in the read
    // fixture stores for this scope.
    expect(
      tenantRefOf(scope('e6bece78-d0a1-4a41-8588-73a258cf8011', 'b4557662-6345-4196-ac9d-6da5f6c08a9e')),
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
    expect(() => tenantRefOf(scope('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 42 as unknown as string))).toThrow(
      InvalidInputError,
    );
  });
});
