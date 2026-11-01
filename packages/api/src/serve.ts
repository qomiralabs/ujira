// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';

export interface ServeOptions {
  readonly port: number;
  readonly hostname: string;
  readonly requestTimeoutMs: number;
}

export interface RunningServer {
  /** The bound port, which differs from the option when that was 0. */
  readonly port: number;
  readonly close: () => Promise<void>;
}

/** Serves the app over HTTP/1.1 and resolves once it is listening. */
export async function startServer(app: Hono, options: ServeOptions): Promise<RunningServer> {
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  // The socket gets a little longer than the handler deadline, so a slow
  // client cannot hold a connection open forever, and a handler that runs
  // to its deadline still gets its 503 out.
  server.requestTimeout = options.requestTimeoutMs + 5_000;
  server.headersTimeout = Math.min(server.requestTimeout, 10_000);
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
