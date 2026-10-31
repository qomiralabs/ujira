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
    ).toEqual({ port: 3000, hostname: '0.0.0.0', requestTimeoutMs: 2500, bodyLimitBytes: 4096 });
  });

  it('names a bad setting without repeating its value', () => {
    const load = () =>
      loadApiConfig({ UJIRA_API_PORT: '70000', UJIRA_API_REQUEST_TIMEOUT_MS: 'soon-ish' });
    expect(load).toThrow(ApiConfigError);
    expect(load).toThrow(/UJIRA_API_PORT, UJIRA_API_REQUEST_TIMEOUT_MS/);
    expect(load).not.toThrow(/70000|soon-ish/);
  });
});
