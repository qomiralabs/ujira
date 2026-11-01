// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  IDENTITY_ERROR_CODES,
  IdentityConfigError,
  IdentityInputError,
  IdentityTenantMismatchError,
  isIdentityError,
  issuesOf,
} from './errors.js';
import type { IdentityError } from './errors.js';

describe('identity errors', () => {
  const errors: [IdentityError, string, string][] = [
    [
      new IdentityInputError(['a (invalid_format)']),
      'IdentityInputError',
      'IDENTITY_INVALID_INPUT',
    ],
    [
      new IdentityConfigError(['b (invalid_type)']),
      'IdentityConfigError',
      'IDENTITY_CONFIG_INVALID',
    ],
    [new IdentityTenantMismatchError(), 'IdentityTenantMismatchError', 'IDENTITY_TENANT_MISMATCH'],
  ];

  it('every error class has code and name', () => {
    for (const [error, name, code] of errors) {
      expect(error.name).toBe(name);
      expect(error.code).toBe(code);
      expect(error).toBeInstanceOf(Error);
      expect(isIdentityError(error)).toBe(true);
      expect(error.message.length).toBeGreaterThan(0);
    }
    expect(new Set(errors.map(([error]) => error.code))).toEqual(new Set(IDENTITY_ERROR_CODES));
  });

  it('other errors are not identity errors', () => {
    expect(isIdentityError(new Error('x'))).toBe(false);
    expect(isIdentityError('IDENTITY_INVALID_INPUT')).toBe(false);
  });

  it('issues are frozen copies', () => {
    const issues = ['a (invalid_format)'];
    const error = new IdentityInputError(issues);
    issues.push('b (invalid_type)');
    expect(error.issues).toEqual(['a (invalid_format)']);
    expect(Object.isFrozen(error.issues)).toBe(true);
  });

  it('issuesOf keeps the path and code and drops the value', () => {
    const parsed = z
      .object({ email: z.email(), nested: z.object({ n: z.number() }) })
      .safeParse({ email: 'jane@example', nested: { n: 'x' } });
    if (parsed.success) throw new Error('expected a failure');
    const issues = issuesOf(parsed.error);
    expect(issues).toEqual(['email (invalid_format)', 'nested.n (invalid_type)']);
    expect(issues.join(' ')).not.toContain('jane');
    const root = z.string().safeParse(1);
    if (root.success) throw new Error('expected a failure');
    expect(issuesOf(root.error)).toEqual(['(root) (invalid_type)']);
  });
});
