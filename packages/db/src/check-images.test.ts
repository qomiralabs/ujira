// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every Postgres image the tests, scripts and CI start is pinned by digest. A tag
// can be pushed again with other contents, and then a run would test a server
// nobody chose.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { POSTGRES_IMAGE } from './testing/image.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// Where an image could be named: this package, the root scripts, the workflows
// and the root configuration.
const PLACES = ['packages/db', 'scripts', '.github', 'vitest.config.ts', 'turbo.json'];
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.turbo']);

function files(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => (SKIP.has(name) ? [] : files(join(path, name))));
}

// A Postgres image is `postgres:` followed by a tag that starts with a digit.
// A connection URL or a protocol check has `postgres:` followed by a slash or a
// quote, so neither is read as an image.
const IMAGE = /\bpostgres:\d[\w.-]*(@sha256:[0-9a-f]{64})?/g;

function unpinnedImages(text: string): string[] {
  return [...text.matchAll(IMAGE)].filter((match) => match[1] === undefined).map((m) => m[0]);
}

describe('Postgres images', () => {
  it('every one is pinned by digest', () => {
    const found: string[] = [];
    const unpinned: string[] = [];
    for (const place of PLACES) {
      for (const file of files(join(ROOT, place))) {
        if (file === fileURLToPath(import.meta.url)) continue;
        const text = readFileSync(file, 'utf8');
        found.push(...[...text.matchAll(IMAGE)].map((match) => match[0]));
        unpinned.push(...unpinnedImages(text).map((image) => `${relative(ROOT, file)}: ${image}`));
      }
    }
    expect(unpinned).toEqual([]);
    // Not vacuous: the image the harness starts is found and is pinned.
    expect(found).toContain(POSTGRES_IMAGE);
  });

  it('reads a tag as unpinned and a digest as pinned, and leaves URLs alone', () => {
    expect(unpinnedImages("image: 'postgres:17.6'")).toEqual(['postgres:17.6']);
    expect(unpinnedImages('postgres:17-alpine')).toEqual(['postgres:17-alpine']);
    expect(unpinnedImages(`postgres:17.6@sha256:${'a'.repeat(64)}`)).toEqual([]);
    expect(unpinnedImages("'postgres://u:p@localhost:5432/db' protocol === 'postgres:'")).toEqual(
      [],
    );
  });
});
