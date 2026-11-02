// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the mandate policy errors (errors.ts) and port helpers
 * (ports.ts): every class has a stable code from MANDATE_POLICY_ERROR_CODES
 * and a spelled out name; keyText keys a record by all three IDs.
 */

import { describe, expect, it } from 'vitest';

import { key } from '../test/world.js';
import {
  CustodyGuardError,
  MANDATE_POLICY_ERROR_CODES,
  OperationsGuardianNotConfiguredError,
  PolicyStoreError,
  PolicyStoreTimeoutError,
  callPort,
  isMandatePolicyError,
  keyText,
} from './index.js';
import type { MandatePolicyError } from './index.js';

describe('mandate policy errors', () => {
  it('every error class has code and name', () => {
    const all: [MandatePolicyError, string][] = [
      [new CustodyGuardError(), 'CustodyGuardError'],
      [new OperationsGuardianNotConfiguredError(), 'OperationsGuardianNotConfiguredError'],
      [new PolicyStoreTimeoutError(), 'PolicyStoreTimeoutError'],
      [new PolicyStoreError(new Error('x')), 'PolicyStoreError'],
    ];
    expect(all.map(([e]) => e.code).sort()).toEqual([...MANDATE_POLICY_ERROR_CODES].sort());
    for (const [error, name] of all) {
      expect(error.name).toBe(name);
      expect(isMandatePolicyError(error)).toBe(true);
    }
    expect(isMandatePolicyError(new Error('x'))).toBe(false);
  });

  it('keys a record by principal, project and mandate', () => {
    expect(keyText(key('a', 'm'))).not.toBe(keyText(key('b', 'm')));
    expect(keyText(key('a', 'm'))).toBe(keyText(key('a', 'm')));
  });

  it('passes a typed error from a port through unchanged', async () => {
    const typed = new OperationsGuardianNotConfiguredError();
    await expect(callPort(() => Promise.reject(typed))).rejects.toBe(typed);
  });

  it('wraps a port that throws synchronously', async () => {
    await expect(
      callPort(() => {
        throw new TypeError('bug');
      }),
    ).rejects.toThrow(PolicyStoreError);
  });
});
