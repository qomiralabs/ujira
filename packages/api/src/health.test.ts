// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { refuseAllCredentials } from './auth.js';
import { memoryLogger } from './log.js';
import { allowEveryRequest } from './rate-limit.js';
import { V1_ROUTES } from './routes/index.js';

describe('health', () => {
  it('GET /v1/health returns 200', async () => {
    const logger = memoryLogger();
    const app = createApp({
      routes: V1_ROUTES,
      authenticate: refuseAllCredentials,
      rateLimit: allowEveryRequest,
      logger,
    });

    const response = await app.request('/v1/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('request-id')).toMatch(/^req_[A-Za-z0-9_-]{24}$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(logger.records).toEqual([
      expect.objectContaining({
        event: 'request',
        route: '/v1/health',
        method: 'GET',
        status: 200,
        requestId: response.headers.get('request-id'),
      }),
    ]);
    // A public route runs with no tenant, so none is logged.
    expect(logger.records[0]).not.toHaveProperty('principalId');
  });

  it('needs no key, even when every key is refused', async () => {
    const app = createApp({
      routes: V1_ROUTES,
      authenticate: refuseAllCredentials,
      rateLimit: allowEveryRequest,
      logger: memoryLogger(),
    });
    const response = await app.request('/v1/health', {
      headers: { authorization: 'Bearer anything' },
    });
    expect(response.status).toBe(200);
  });
});
