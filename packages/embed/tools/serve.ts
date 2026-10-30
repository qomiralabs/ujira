// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Serves the plain HTML host page and the built widget for the browser tests.
// It is the same thing an integrator does: one script tag, one element.
//
//   node tools/serve.ts [port]

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { BUNDLE_PATH, bundleWidget } from './bundle.ts';

export const DEFAULT_PORT = 4178;

const PAGES: Readonly<Record<string, string>> = {
  '/': 'e2e/host.html',
  '/host.html': 'e2e/host.html',
};

export interface Running {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(root: string, port = DEFAULT_PORT): Promise<Running> {
  const bundle = await bundleWidget(root);
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path === BUNDLE_PATH) {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(bundle.code);
      return;
    }
    const page = PAGES[path];
    if (page === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(readFileSync(join(root, page), 'utf8'));
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

if (import.meta.main) {
  const argument = process.argv[2];
  const port = argument === undefined ? DEFAULT_PORT : Number.parseInt(argument, 10);
  const running = await startServer(join(import.meta.dirname, '..'), port);
  process.stdout.write(`host page on ${running.url}/host.html\n`);
}
