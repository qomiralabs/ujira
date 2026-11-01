// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { parseIdentityConfig, parseProjectIdentitySettings } from './config.js';
import { IdentityConfigError } from './errors.js';

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('parseIdentityConfig', () => {
  it('leaves every provider off unless it is switched on', () => {
    expect(parseIdentityConfig({})).toEqual({
      providers: {
        self: { enabled: false },
        sep12: { enabled: false },
        principal: { enabled: false },
      },
      attestation: { ttlSeconds: 86_400, callTimeoutMs: 5_000 },
    });
    expect(parseIdentityConfig({ providers: { self: { enabled: true } } }).providers).toEqual({
      self: { enabled: true },
      sep12: { enabled: false },
      principal: { enabled: false },
    });
  });

  it('refuses unknown providers, unknown keys and non boolean switches by path', () => {
    const cases: [unknown, string][] = [
      [{ providers: { onfido: { enabled: true } } }, 'providers (unrecognized_keys)'],
      [{ providers: { self: { enabled: 'yes' } } }, 'providers.self.enabled (invalid_type)'],
      [{ extra: 1 }, '(root) (unrecognized_keys)'],
      [null, '(root) (invalid_type)'],
    ];
    for (const [raw, issue] of cases) {
      const error = thrownBy(() => parseIdentityConfig(raw));
      expect(error).toBeInstanceOf(IdentityConfigError);
      expect((error as IdentityConfigError).issues).toEqual([issue]);
    }
  });
});

describe('attestation settings', () => {
  it('keeps the window between a minute and the mandate maximum, and the timeout bounded', () => {
    expect(parseIdentityConfig({ attestation: { ttlSeconds: 60 } }).attestation).toEqual({
      ttlSeconds: 60,
      callTimeoutMs: 5_000,
    });
    const cases: [unknown, string][] = [
      [{ attestation: { ttlSeconds: 59 } }, 'attestation.ttlSeconds (too_small)'],
      [{ attestation: { ttlSeconds: 86_401 } }, 'attestation.ttlSeconds (too_big)'],
      [{ attestation: { ttlSeconds: 90.5 } }, 'attestation.ttlSeconds (invalid_type)'],
      [{ attestation: { callTimeoutMs: 60_001 } }, 'attestation.callTimeoutMs (too_big)'],
    ];
    for (const [raw, issue] of cases) {
      const error = thrownBy(() => parseIdentityConfig(raw));
      expect((error as IdentityConfigError).issues).toEqual([issue]);
    }
  });
});

describe('parseProjectIdentitySettings', () => {
  it('defaults to self_pre_kyc when nothing is stored', () => {
    expect(parseProjectIdentitySettings(null)).toEqual({ recipientRequirement: 'self_pre_kyc' });
    expect(parseProjectIdentitySettings(undefined)).toEqual({
      recipientRequirement: 'self_pre_kyc',
    });
    expect(parseProjectIdentitySettings({})).toEqual({ recipientRequirement: 'self_pre_kyc' });
  });

  it('keeps each declared requirement', () => {
    for (const requirement of ['self_pre_kyc', 'principal_attested', 'none'] as const) {
      expect(parseProjectIdentitySettings({ recipientRequirement: requirement })).toEqual({
        recipientRequirement: requirement,
      });
    }
  });

  it('refuses an unknown requirement without echoing it', () => {
    const error = thrownBy(() =>
      parseProjectIdentitySettings({ recipientRequirement: 'jane@example.com' }),
    );
    expect(error).toBeInstanceOf(IdentityConfigError);
    expect((error as IdentityConfigError).issues).toEqual(['recipientRequirement (invalid_value)']);
    expect((error as Error).message).not.toContain('jane');
  });
});
