// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { refuseAllCredentials } from './auth.js';
import { memoryLogger } from './log.js';
import { allowEveryAddress, allowEveryRequest } from './rate-limit.js';
import { V1_ROUTES } from './routes/index.js';
import { startServer } from './serve.js';

describe('startServer', () => {
  it('serves health and the OpenAPI document over HTTP, then closes', async () => {
    const app = createApp({
      routes: V1_ROUTES,
      authenticate: refuseAllCredentials,
      rateLimit: allowEveryRequest,
      addressRateLimit: allowEveryAddress,
      logger: memoryLogger(),
    });
    const server = await startServer(app, {
      port: 0,
      hostname: '127.0.0.1',
      requestTimeoutMs: 1000,
    });
    try {
      const base = `http://127.0.0.1:${String(server.port)}`;
      const health = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(5000) });
      expect(health.status).toBe(200);
      const doc = (await (
        await fetch(`${base}/v1/openapi.json`, { signal: AbortSignal.timeout(5000) })
      ).json()) as { paths: Record<string, unknown> };
      expect(Object.keys(doc.paths)).toContain('/v1/health');
    } finally {
      await server.close();
    }
  });

  it('rejects when the port is taken', async () => {
    const app = createApp({
      routes: V1_ROUTES,
      authenticate: refuseAllCredentials,
      rateLimit: allowEveryRequest,
      addressRateLimit: allowEveryAddress,
      logger: memoryLogger(),
    });
    const first = await startServer(app, {
      port: 0,
      hostname: '127.0.0.1',
      requestTimeoutMs: 1000,
    });
    try {
      await expect(
        startServer(app, { port: first.port, hostname: '127.0.0.1', requestTimeoutMs: 1000 }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await first.close();
    }
  });
});
