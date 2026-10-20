// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Serves the built catalogue for the browser tests. A plain file server
// instead of a dev server, so the tests need nothing but Node and a browser:
// the same command runs locally and in the Playwright container.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'storybook-static');
const PORT = Number(process.env['CATALOGUE_PORT'] ?? '6007');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

// Resolves a request path inside the built output, or undefined when it
// points outside it or at something that is not a file.
function fileFor(url: string): string | undefined {
  const path = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  const target = resolve(ROOT, `.${normalize(path)}`);
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return undefined;
  const candidates = [target, join(target, 'index.html')];
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

const server = createServer((request, response) => {
  const file = request.url === undefined ? undefined : fileFor(request.url);
  if (file === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
});

server.listen(PORT, '127.0.0.1');
