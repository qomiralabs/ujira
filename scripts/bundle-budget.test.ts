// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BudgetError,
  checkBudget,
  formatReport,
  measureRoutes,
  parseRouteStats,
  ROUTE_STATS,
} from './bundle-budget.ts';

const apps: string[] = [];

afterEach(() => {
  for (const dir of apps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A fake Next.js app folder with the given chunks and route stats.
function app(chunks: Record<string, Buffer | string>, stats: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'ujira-budget-'));
  apps.push(dir);
  mkdirSync(join(dir, '.next', 'static', 'chunks'), { recursive: true });
  mkdirSync(join(dir, '.next', 'diagnostics'), { recursive: true });
  for (const [name, body] of Object.entries(chunks)) {
    writeFileSync(join(dir, '.next', 'static', 'chunks', name), body);
  }
  writeFileSync(join(dir, ROUTE_STATS), typeof stats === 'string' ? stats : JSON.stringify(stats));
  return dir;
}

function route(name: string, chunks: string[]) {
  return {
    route: name,
    firstLoadUncompressedJsBytes: 1,
    firstLoadChunkPaths: chunks.map((c) => `.next/static/chunks/${c}`),
  };
}

describe('bundle budget', () => {
  describe('parseRouteStats', () => {
    it('reads the route list Next.js writes', () => {
      expect(parseRouteStats(JSON.stringify([route('/', ['a.js'])]))).toEqual([
        { route: '/', chunks: ['.next/static/chunks/a.js'] },
      ]);
    });

    it.each([
      ['not JSON', '{'],
      ['not a list', '{}'],
      ['an empty list', '[]'],
      ['a route without a name', JSON.stringify([{ firstLoadChunkPaths: [] }])],
      ['chunks that are not strings', JSON.stringify([{ route: '/', firstLoadChunkPaths: [1] }])],
      ['a route without chunks', JSON.stringify([{ route: '/' }])],
    ])('fails closed on %s', (_label, text) => {
      expect(() => parseRouteStats(text)).toThrow(BudgetError);
    });
  });

  describe('measureRoutes', () => {
    it('sums the gzipped size of every first load chunk of a route', () => {
      const a = 'console.log("a");'.repeat(50);
      const b = 'console.log("b");'.repeat(20);
      const dir = app({ 'a.js': a, 'b.js': b }, [
        route('/', ['a.js', 'b.js']),
        route('/x', ['a.js']),
      ]);
      const sizes = measureRoutes(dir);
      expect(sizes).toEqual([
        {
          route: '/',
          chunks: 2,
          gzipBytes: gzipSync(a).length + gzipSync(b).length,
        },
        { route: '/x', chunks: 1, gzipBytes: gzipSync(a).length },
      ]);
    });

    it('fails when the build has no route stats', () => {
      const dir = app({}, []);
      rmSync(join(dir, ROUTE_STATS));
      expect(() => measureRoutes(dir)).toThrow(
        /route-bundle-stats\.json not found; run next build/,
      );
    });

    it('fails when a listed chunk is missing', () => {
      const dir = app({}, [route('/', ['gone.js'])]);
      expect(() => measureRoutes(dir)).toThrow(
        '/: chunk .next/static/chunks/gone.js is missing from the build',
      );
    });

    it.each(['../../etc/passwd', '/etc/passwd', '.next/server/app/page.js'])(
      'refuses a chunk path outside .next/static: %s',
      (chunk) => {
        const dir = app({}, [
          { route: '/', firstLoadUncompressedJsBytes: 1, firstLoadChunkPaths: [chunk] },
        ]);
        expect(() => measureRoutes(dir)).toThrow(`/: chunk ${chunk} is outside .next/static`);
      },
    );
  });

  describe('checkBudget', () => {
    it('passes routes at or under the budget and fails routes over it', () => {
      const result = checkBudget(
        [
          { route: '/', chunks: 3, gzipBytes: 250_000 },
          { route: '/heavy', chunks: 4, gzipBytes: 250_001 },
        ],
        250_000,
      );
      expect(result.over.map((r) => r.route)).toEqual(['/heavy']);
      expect(result.ok).toBe(false);
    });

    it('fails a fixture route built from incompressible chunks over 250 KB', () => {
      // Random bytes do not compress, so gzip leaves them just over 260 KB.
      const dir = app({ 'heavy.js': randomBytes(260_000), 'small.js': 'export {};' }, [
        route('/', ['small.js']),
        route('/budget-fixture', ['small.js', 'heavy.js']),
      ]);
      const result = checkBudget(measureRoutes(dir), 250_000);
      expect(result.ok).toBe(false);
      expect(result.over.map((r) => r.route)).toEqual(['/budget-fixture']);
      expect(formatReport(result)).toMatch(/\/budget-fixture +2\d\d\.\d kB +over budget/);
    });
  });

  describe('formatReport', () => {
    it('lists every route with its size and the budget', () => {
      const text = formatReport(
        checkBudget(
          [
            { route: '/', chunks: 3, gzipBytes: 141_234 },
            { route: '/payouts', chunks: 3, gzipBytes: 260_000 },
          ],
          250_000,
        ),
      );
      expect(text).toBe(
        [
          'Route JavaScript, gzipped, budget 250.0 kB per route',
          '  /          141.2 kB  ok',
          '  /payouts   260.0 kB  over budget',
          '1 route over budget',
          '',
        ].join('\n'),
      );
    });

    it('says so when every route is within budget', () => {
      const text = formatReport(checkBudget([{ route: '/', chunks: 1, gzipBytes: 1000 }], 250_000));
      expect(text).toContain('Every route is within budget');
    });
  });
});
