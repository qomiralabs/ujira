// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { IdentityConfigError } from '../errors.js';

import { checkSelfApiKey, parseSelfConfig, selfFlowRules } from './config.js';
import type { Deployment, SelfEnvironment } from './config.js';

function issuesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof IdentityConfigError) return error.issues;
    throw error;
  }
  return [];
}

describe('parseSelfConfig', () => {
  it('defaults to the test environment and fixed flow rules', () => {
    const config = parseSelfConfig({
      flowId: 'flow_1',
      flowVersion: '2',
      excludedCountries: ['KP'],
    });
    expect(config).toEqual({
      environment: 'test',
      flowId: 'flow_1',
      flowVersion: '2',
      excludedCountries: ['KP'],
      webhookToleranceSeconds: 300,
      callTimeoutMs: 5_000,
    });
    expect(selfFlowRules(config)).toEqual({
      minimumAge: 18,
      ofac: true,
      excludedCountries: ['KP'],
      reveals: [],
      security: 'high',
      mode: 'backend',
    });
  });

  it('names bad fields under self', () => {
    expect(issuesOf(() => parseSelfConfig({ flowVersion: '1' }))).toEqual([
      'self.flowId (invalid_type)',
    ]);
    expect(
      issuesOf(() => parseSelfConfig({ flowId: 'f', flowVersion: '1', excludedCountries: ['kp'] })),
    ).toEqual(['self.excludedCountries.0 (invalid_format)']);
  });
});

describe('checkSelfApiKey', () => {
  const cases: [string, Deployment, SelfEnvironment, string | null][] = [
    ['sk_test_a', 'development', 'test', null],
    ['sk_test_a', 'staging', 'test', null],
    ['sk_live_a', 'production', 'live', null],
    ['sk_test_a', 'production', 'test', 'self.apiKey (wrong_deployment)'],
    ['sk_live_a', 'staging', 'live', 'self.apiKey (wrong_deployment)'],
    ['sk_live_a', 'production', 'test', 'self.environment (key_mismatch)'],
    ['sk_test_a', 'test', 'live', 'self.environment (key_mismatch)'],
    ['pk_test_a', 'test', 'test', 'self.apiKey (invalid_format)'],
  ];

  it.each(cases)('%s in %s with %s', (key, deployment, environment, issue) => {
    const issues = issuesOf(() => {
      checkSelfApiKey(key, deployment, environment);
    });
    expect(issues).toEqual(issue === null ? [] : [issue]);
    expect(issues.join(' ')).not.toContain(key);
  });
});
