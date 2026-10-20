// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Measures the JavaScript each route of a built Next.js app loads first, gzipped,
// and compares it with a per route budget. The chunk list comes from the route
// stats next build writes; anything unexpected in it fails the check instead of
// being skipped, so a change in the Next.js output cannot pass silently.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

export const ROUTE_STATS = join('.next', 'diagnostics', 'route-bundle-stats.json');

export class BudgetError extends Error {
  override name = 'BudgetError';
}

export interface RouteChunks {
  route: string;
  chunks: string[];
}

export interface RouteSize {
  route: string;
  chunks: number;
  gzipBytes: number;
}

export interface BudgetResult {
  budgetBytes: number;
  routes: RouteSize[];
  over: RouteSize[];
  ok: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRouteStats(text: string): RouteChunks[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BudgetError('route stats are not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new BudgetError('route stats must be a non empty list of routes');
  }
  return parsed.map((entry: unknown, index) => {
    const where = `route stats entry ${String(index)}`;
    if (!isRecord(entry) || typeof entry['route'] !== 'string' || entry['route'] === '') {
      throw new BudgetError(`${where} has no route name`);
    }
    const chunks = entry['firstLoadChunkPaths'];
    if (!Array.isArray(chunks) || !chunks.every((c): c is string => typeof c === 'string')) {
      throw new BudgetError(`${where} (${entry['route']}) has no list of chunk paths`);
    }
    return { route: entry['route'], chunks };
  });
}

// Gzipped size of every route's first load JavaScript. Chunk paths are read
// relative to the app folder and must stay inside .next/static.
export function measureRoutes(appDir: string): RouteSize[] {
  const statsFile = join(appDir, ROUTE_STATS);
  if (!existsSync(statsFile)) {
    throw new BudgetError(`${ROUTE_STATS} not found; run next build in ${appDir} first`);
  }
  const staticDir = join(appDir, '.next', 'static');
  const cache = new Map<string, number>();
  return parseRouteStats(readFileSync(statsFile, 'utf8')).map(({ route, chunks }) => {
    let gzipBytes = 0;
    for (const chunk of chunks) {
      const file = join(appDir, chunk);
      const inside = relative(staticDir, file);
      if (isAbsolute(chunk) || inside.startsWith('..') || isAbsolute(inside)) {
        throw new BudgetError(`${route}: chunk ${chunk} is outside .next/static`);
      }
      if (!existsSync(file)) {
        throw new BudgetError(`${route}: chunk ${chunk} is missing from the build`);
      }
      // A link could point the measurement at some other file.
      if (!realpathSync(file).startsWith(realpathSync(staticDir) + sep)) {
        throw new BudgetError(`${route}: chunk ${chunk} is outside .next/static`);
      }
      let size = cache.get(file);
      if (size === undefined) {
        size = gzipSync(readFileSync(file)).length;
        cache.set(file, size);
      }
      gzipBytes += size;
    }
    return { route, chunks: chunks.length, gzipBytes };
  });
}

export function checkBudget(routes: readonly RouteSize[], budgetBytes: number): BudgetResult {
  const over = routes.filter((r) => r.gzipBytes > budgetBytes);
  return { budgetBytes, routes: [...routes], over, ok: over.length === 0 };
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

export function formatReport(result: BudgetResult): string {
  const width = Math.max(...result.routes.map((r) => r.route.length)) + 2;
  const lines = [`Route JavaScript, gzipped, budget ${kilobytes(result.budgetBytes)} per route`];
  for (const r of result.routes) {
    const verdict = r.gzipBytes > result.budgetBytes ? 'over budget' : 'ok';
    lines.push(`  ${r.route.padEnd(width)}${kilobytes(r.gzipBytes).padStart(9)}  ${verdict}`);
  }
  const count = result.over.length;
  lines.push(
    count === 0
      ? 'Every route is within budget'
      : `${String(count)} route${count === 1 ? '' : 's'} over budget`,
  );
  return `${lines.join('\n')}\n`;
}
