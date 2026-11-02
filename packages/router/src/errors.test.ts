// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the router's errors (errors.ts): every class has a stable
 * code from ROUTING_CONFIG_ERROR_CODES and a spelled out name, messages are
 * fixed text, and isRoutingConfigError recognises exactly these classes.
 */

import { describe, expect, it } from 'vitest';

import {
  ROUTING_CONFIG_ERROR_CODES,
  RoutingConfigInvalidError,
  RoutingConfigStoreError,
  RoutingConfigStoreTimeoutError,
  RoutingConfigUnavailableError,
  RoutingConfigVersionNotFoundError,
  isRoutingConfigError,
} from './index.js';
import type { RoutingConfigError } from './index.js';

describe('routing config errors', () => {
  const all: [RoutingConfigError, string, string][] = [
    [
      new RoutingConfigInvalidError(['a (b)']),
      'RoutingConfigInvalidError',
      'ROUTING_CONFIG_INVALID',
    ],
    [
      new RoutingConfigUnavailableError(),
      'RoutingConfigUnavailableError',
      'ROUTING_CONFIG_UNAVAILABLE',
    ],
    [
      new RoutingConfigVersionNotFoundError(),
      'RoutingConfigVersionNotFoundError',
      'ROUTING_CONFIG_VERSION_NOT_FOUND',
    ],
    [
      new RoutingConfigStoreTimeoutError(),
      'RoutingConfigStoreTimeoutError',
      'ROUTING_CONFIG_STORE_TIMEOUT',
    ],
    [
      new RoutingConfigStoreError(new Error('x')),
      'RoutingConfigStoreError',
      'ROUTING_CONFIG_STORE_FAILED',
    ],
  ];

  it('every error class has code and name', () => {
    expect(all.map(([, , code]) => code).sort()).toEqual([...ROUTING_CONFIG_ERROR_CODES].sort());
    for (const [error, name, code] of all) {
      expect(error.name).toBe(name);
      expect(error.code).toBe(code);
      expect(error).toBeInstanceOf(Error);
      expect(isRoutingConfigError(error)).toBe(true);
    }
  });

  it('freezes the issue list it was given', () => {
    const issues = ['rails.0.id (invalid_format)'];
    const error = new RoutingConfigInvalidError(issues);
    issues.push('later (custom)');
    expect(error.issues).toEqual(['rails.0.id (invalid_format)']);
    expect(Object.isFrozen(error.issues)).toBe(true);
  });

  it('recognises nothing else', () => {
    for (const value of [new Error('x'), { code: 'ROUTING_CONFIG_INVALID' }, null, 'x']) {
      expect(isRoutingConfigError(value)).toBe(false);
    }
  });
});
