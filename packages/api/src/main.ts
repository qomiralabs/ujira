// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Runs the API: `pnpm --filter @ujira/api build`, then
// `pnpm --filter @ujira/api start`. With no database configured, every tenant
// route refuses every key; health and the OpenAPI document answer.

import { apiAccessFromEnv } from './access.js';
import { createApp } from './app.js';
import { loadApiConfig } from './config.js';
import { stdoutLogger } from './log.js';
import { V1_ROUTES } from './routes/index.js';
import { startServer } from './serve.js';

const config = loadApiConfig(process.env);
const access = apiAccessFromEnv(config, process.env, stdoutLogger);
const app = createApp({
  routes: V1_ROUTES,
  authenticate: access.authenticate,
  rateLimit: access.rateLimit,
  idempotency: access.idempotency,
  logger: stdoutLogger,
  requestTimeoutMs: config.requestTimeoutMs,
  bodyLimitBytes: config.bodyLimitBytes,
});
const server = await startServer(app, config);
stdoutLogger.write({
  time: new Date().toISOString(),
  level: 'info',
  event: 'listening',
  port: server.port,
});

const stop = (): void => {
  Promise.all([server.close(), access.close()]).then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
