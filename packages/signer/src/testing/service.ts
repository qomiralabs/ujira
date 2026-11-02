// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A signer service over the local backend, reached through RemoteSigner
// with the service's own fetch handler, so a test exercises the whole path
// (wire, authentication, policy, backend, verification) without a socket.

import type { CallOptions, SignerProvider } from '@ujira/chain-adapter';

import { LocalSigner } from '../local-signer.js';
import { RemoteSigner } from '../remote.js';
import { createSignerService, memorySignerLogger } from '../service/index.js';
import type { ServicePolicy, SignerLogRecord } from '../service/index.js';

/** A fixed test seed, built rather than written out so it never reads as a key. */
export const TEST_SEED = '3c'.repeat(32);
export const CALLER_TOKEN = `payouts-${'t'.repeat(40)}`;
export const OTHER_TOKEN = `adapter-${'u'.repeat(40)}`;
export const OPTS: CallOptions = { correlationId: 'signer-service-test' };

export interface Harness {
  readonly backend: LocalSigner;
  readonly remote: RemoteSigner;
  /** A client with a token the service does not know. */
  readonly stranger: RemoteSigner;
  readonly records: SignerLogRecord[];
  readonly fetch: typeof fetch;
}

export interface HarnessOptions {
  readonly policy: ServicePolicy;
  /** Unix seconds the service reads as now. */
  readonly nowSeconds?: number;
  readonly provider?: SignerProvider;
}

export function harness(options: HarnessOptions): Harness {
  const backend = new LocalSigner({ seed: TEST_SEED, nodeEnv: 'test' });
  const logger = memorySignerLogger();
  let id = 0;
  const app = createSignerService({
    provider: options.provider ?? backend,
    policy: options.policy,
    callers: [
      { name: 'payouts', token: CALLER_TOKEN },
      { name: 'adapter', token: OTHER_TOKEN },
    ],
    logger,
    backendTimeoutMs: 5_000,
    ...(options.nowSeconds === undefined
      ? {}
      : { now: () => new Date((options.nowSeconds ?? 0) * 1000) }),
    newRequestId: () => `request-${String((id += 1))}`,
  });
  const fetchVia: typeof fetch = (input, init) =>
    Promise.resolve(app.fetch(new Request(input, init)));
  const client = (token: string) =>
    new RemoteSigner({
      baseUrl: 'http://signer.internal:10000',
      token,
      timeoutMs: 5_000,
      fetch: fetchVia,
    });
  return {
    backend,
    remote: client(CALLER_TOKEN),
    stranger: client(`nobody-${'v'.repeat(40)}`),
    records: logger.records,
    fetch: fetchVia,
  };
}

/** The code a call fails with, or "resolved". */
export async function codeOf(run: Promise<unknown>): Promise<unknown> {
  const outcome = await run.then(
    () => ({ code: 'resolved' }),
    (error: unknown) => error as { code?: unknown },
  );
  return outcome.code;
}
