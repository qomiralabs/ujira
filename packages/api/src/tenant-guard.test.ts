// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { foreignTenantPath } from './tenant-guard.js';

const A = { principalId: 'p-a', projectId: 'j-a' };

describe('foreignTenantPath', () => {
  it('passes a body that names only the caller', () => {
    expect(foreignTenantPath({ items: [{ ...A, id: 1 }], nextCursor: null }, A)).toBeNull();
    expect(foreignTenantPath({ status: 'ok' }, A)).toBeNull();
    expect(foreignTenantPath(null, A)).toBeNull();
  });

  it('finds another principal or project at any depth', () => {
    const body = { items: [{ ...A }, { legs: [{ ...A, projectId: 'j-b' }] }] };
    expect(foreignTenantPath(body, A)).toBe('items.1.legs.0.projectId');
    expect(foreignTenantPath([{ principalId: 'p-b' }], A)).toBe('0.principalId');
    // A missing or mistyped id is not the caller's either.
    expect(foreignTenantPath({ principalId: null }, A)).toBe('principalId');
  });

  it('treats a body too deep to check as foreign', () => {
    let deep: unknown = { ...A };
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(foreignTenantPath(deep, A)).not.toBeNull();
  });
});
