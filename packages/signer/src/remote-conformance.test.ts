// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// RemoteSigner against the suite every backend must pass, over a real
// socket to the signer service running with the local backend. The service
// runs with no policy of its own here, so the suite checks the transport
// and the backend's own policy; each deployment's policy has its own tests.

import { afterAll } from 'vitest';

import { LocalSigner, RemoteAttesterSigner, RemoteSigner } from './index.js';
import {
  backendOnlyPolicy,
  createSignerService,
  memorySignerLogger,
  startSignerService,
} from './service/index.js';
import type { RunningService } from './service/index.js';
import { describeSignerProvider } from './testing/conformance.js';
import { CALLER_TOKEN, TEST_SEED } from './testing/service.js';

let running: RunningService | undefined;

afterAll(async () => {
  await running?.close();
});

describeSignerProvider('RemoteSigner', async () => {
  const app = createSignerService({
    provider: new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' }),
    policy: backendOnlyPolicy(),
    callers: [{ name: 'payouts', token: CALLER_TOKEN }],
    logger: memorySignerLogger(),
    backendTimeoutMs: 5_000,
  });
  running = await startSignerService(app, {
    port: 0,
    hostname: '127.0.0.1',
    requestTimeoutMs: 30_000,
  });
  const client = {
    baseUrl: `http://127.0.0.1:${String(running.port)}`,
    token: CALLER_TOKEN,
    timeoutMs: 30_000,
  };
  return { provider: new RemoteSigner(client), attester: new RemoteAttesterSigner(client) };
});
