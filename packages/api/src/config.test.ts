// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { loadApiConfig } from './config.js';
import { ApiConfigError } from './errors.js';

describe('loadApiConfig', () => {
  it('defaults to loopback with the pipeline defaults', () => {
    expect(loadApiConfig({})).toEqual({
      port: 8080,
      hostname: '127.0.0.1',
      requestTimeoutMs: 10_000,
      bodyLimitBytes: 1_048_576,
      environment: 'sandbox',
      embedOrigins: [],
    });
  });

  it('reads every setting', () => {
    expect(
      loadApiConfig({
        UJIRA_API_PORT: '3000',
        UJIRA_API_HOST: '0.0.0.0',
        UJIRA_API_REQUEST_TIMEOUT_MS: '2500',
        UJIRA_API_BODY_LIMIT_BYTES: '4096',
      }),
    ).toMatchObject({
      port: 3000,
      hostname: '0.0.0.0',
      requestTimeoutMs: 2500,
      bodyLimitBytes: 4096,
    });
  });

  it('runs as the sandbox with no embed origins unless told otherwise', () => {
    expect(loadApiConfig({})).toMatchObject({ environment: 'sandbox', embedOrigins: [] });
  });

  it('reads the environment and the embed origins', () => {
    expect(
      loadApiConfig({
        UJIRA_API_ENVIRONMENT: 'production',
        UJIRA_API_EMBED_ORIGINS: 'https://pay.example.test, https://other.example.test:8443',
      }),
    ).toMatchObject({
      environment: 'production',
      embedOrigins: ['https://pay.example.test', 'https://other.example.test:8443'],
    });
  });

  it.each(['https://pay.example.test/', 'https://pay.example.test/path', 'pay.example.test', '*'])(
    'refuses an embed origin that a browser would never send: %s',
    (origin) => {
      expect(() => loadApiConfig({ UJIRA_API_EMBED_ORIGINS: origin })).toThrow(
        /UJIRA_API_EMBED_ORIGINS/,
      );
    },
  );

  it('refuses an environment it does not know', () => {
    expect(() => loadApiConfig({ UJIRA_API_ENVIRONMENT: 'staging' })).toThrow(
      /UJIRA_API_ENVIRONMENT/,
    );
  });

  it('names a bad setting without repeating its value', () => {
    const load = () =>
      loadApiConfig({ UJIRA_API_PORT: '70000', UJIRA_API_REQUEST_TIMEOUT_MS: 'soon-ish' });
    expect(load).toThrow(ApiConfigError);
    expect(load).toThrow(/UJIRA_API_PORT, UJIRA_API_REQUEST_TIMEOUT_MS/);
    expect(load).not.toThrow(/70000|soon-ish/);
  });
});
