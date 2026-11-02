// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';

const KEEP_ALIVE_MS = 65_000;

export interface ServeOptions {
  readonly port: number;
  /** The private network address; never a public interface. */
  readonly hostname: string;
  readonly requestTimeoutMs: number;
}

export interface RunningService {
  /** The bound port, which differs from the option when that was 0. */
  readonly port: number;
  readonly close: () => Promise<void>;
}

/** Serves a signer service over HTTP/1.1 and resolves once it is listening. */
export async function startSignerService(
  app: Hono,
  options: ServeOptions,
): Promise<RunningService> {
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  // A slow client cannot hold a connection open past the request deadline.
  server.requestTimeout = options.requestTimeoutMs;
  server.headersTimeout = Math.min(options.requestTimeoutMs, 10_000);
  // Clients reuse connections. Closing an idle one just as a client writes to
  // it drops that request, so idle connections outlive any normal gap.
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
        server.closeIdleConnections();
      }),
  };
}
