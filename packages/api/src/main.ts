// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Runs the API locally: `pnpm --filter @ujira/api build`, then
// `pnpm --filter @ujira/api start`. Until token authentication lands, every
// tenant route refuses every key; health and the OpenAPI document answer.

import { createApp } from './app.js';
import { refuseAllCredentials } from './auth.js';
import { loadApiConfig } from './config.js';
import { stdoutLogger } from './log.js';
import { V1_ROUTES } from './routes/index.js';
import { startServer } from './serve.js';

const config = loadApiConfig(process.env);
const app = createApp({
  routes: V1_ROUTES,
  authenticate: refuseAllCredentials,
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
  server.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
