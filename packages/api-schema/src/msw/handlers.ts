// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Mock handlers that serve the fixtures with the contract's own rules:
// tenant scoping, keyset pages bound to their query, the filter parser and
// problem bodies. They run in Node and in the browser, so they use no Node
// modules. The cursor here is only encoded, not signed; the real API signs it.

import { HttpResponse, http } from 'msw';
import type { HttpHandler, JsonBodyType } from 'msw';

import type { TenantScope } from '../common.js';
import { buildProblem, parseQuery } from '../contract.js';
import type { FieldError } from '../contract.js';
import { PAGE_LIMIT_DEFAULT } from '../envelope.js';
import type { ProblemCode } from '../envelope.js';
import { toMandateListItem, toPayoutListItem, toReceiptListItem } from '../fixtures/generate.js';
import type { FixtureSet } from '../fixtures/generate.js';
import { ROUTES } from '../routes.js';
import { overviewFixture } from '../fixtures/overview.js';
import type { RouteId, RouteQuery } from '../routes.js';

export interface MockOptions {
  readonly fixtures: FixtureSet;
  /**
   * The tenant a request acts as. A function lets a test switch tenants per
   * request; returning null answers as if no API key was sent.
   */
  readonly scope: TenantScope | ((request: Request) => TenantScope | null);
  /** Origin to match, for example http://localhost:3000. Any origin by default. */
  readonly baseUrl?: string;
}

/**
 * Mock-only header that asks for the recipient view of a receipt. The real
 * API decides the view from the receipt link or embed session instead.
 */
export const MOCK_VIEW_HEADER = 'x-ujira-mock-view';

interface Ordered {
  readonly key: string;
  readonly id: string;
}

const CURSOR_VERSION = 1;

// FNV-1a over the query text, enough to tell one filter from another.
function queryHash(params: URLSearchParams, pageKeys: readonly string[]): string {
  const text = [...params.entries()]
    .filter(([k]) => !pageKeys.includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

const toBase64Url = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function fromBase64Url(text: string): string | null {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function encodeCursor(last: Ordered, hash: string): string {
  return toBase64Url(
    JSON.stringify({ v: CURSOR_VERSION, sortKey: last.key, id: last.id, queryHash: hash }),
  );
}

function decodeCursor(cursor: string, hash: string): Ordered | null {
  const text = fromBase64Url(cursor);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const { v, sortKey, id, queryHash: bound } = value;
    if (
      v !== CURSOR_VERSION ||
      bound !== hash ||
      typeof sortKey !== 'string' ||
      typeof id !== 'string'
    )
      return null;
    return { key: sortKey, id };
  } catch {
    return null;
  }
}

/**
 * One keyset page of rows already in route order. `newestFirst` decides
 * which side of the cursor comes next.
 */
function page<T>(
  rows: readonly T[],
  orderOf: (row: T) => Ordered,
  newestFirst: boolean,
  limit: number,
  after: Ordered | null,
  hash: string,
): { items: T[]; nextCursor: string | null } {
  const isAfter = (row: T): boolean => {
    if (after === null) return true;
    const o = orderOf(row);
    if (o.key === after.key) return newestFirst ? o.id < after.id : o.id > after.id;
    return newestFirst ? o.key < after.key : o.key > after.key;
  };
  const start = rows.findIndex(isAfter);
  const items = start === -1 ? [] : rows.slice(start, start + limit);
  const last = items[items.length - 1];
  const more = start !== -1 && start + limit < rows.length;
  return {
    items,
    nextCursor: more && last !== undefined ? encodeCursor(orderOf(last), hash) : null,
  };
}

/** Builds the handlers for every read route over one fixture set. */
export function createHandlers(options: MockOptions): HttpHandler[] {
  const { fixtures } = options;
  const base = options.baseUrl ?? '*';
  let counter = 0;
  const nextRequestId = (): string => {
    counter += 1;
    return `req_mock_${String(counter).padStart(8, '0')}`;
  };
  const resolveScope = (request: Request): TenantScope | null =>
    typeof options.scope === 'function' ? options.scope(request) : options.scope;
  const inScope = (scope: TenantScope) => (row: TenantScope) =>
    row.principalId === scope.principalId && row.projectId === scope.projectId;

  // Every body here is plain JSON data built from parsed fixtures.
  const ok = (body: unknown, requestId: string): Response =>
    HttpResponse.json(body as JsonBodyType, { status: 200, headers: { 'Request-Id': requestId } });
  const problem = (
    code: ProblemCode,
    requestId: string,
    errors?: readonly FieldError[],
  ): Response => {
    const body = buildProblem(code, requestId, errors === undefined ? {} : { errors });
    return HttpResponse.json(body, {
      status: body.status,
      headers: { 'Request-Id': requestId, 'Content-Type': 'application/problem+json' },
    });
  };

  // Shared steps of every route: a request id, the tenant, the query.
  function route<R extends RouteId>(
    id: R,
    answer: (ctx: {
      scope: TenantScope;
      query: RouteQuery<R>;
      params: Readonly<Record<string, string | readonly string[] | undefined>>;
      request: Request;
      url: URL;
      requestId: string;
    }) => Response,
  ): HttpHandler {
    const path = `${base}${ROUTES[id].path.replace(/\{(\w+)\}/g, ':$1')}`;
    return http.get(path, ({ request, params }) => {
      const requestId = nextRequestId();
      const scope = resolveScope(request);
      if (scope === null) return problem('TOKEN_INVALID', requestId);
      const url = new URL(request.url);
      const parsed = parseQuery(id, url.searchParams);
      if (!parsed.success) return problem(parsed.code, requestId, parsed.errors);
      return answer({ scope, query: parsed.data, params, request, url, requestId });
    });
  }

  const byCreated = (row: { createdAt: string; id: string }): Ordered => ({
    key: row.createdAt,
    id: row.id,
  });
  const limitOf = (limit: number | undefined): number => limit ?? PAGE_LIMIT_DEFAULT;
  const listPage = <T>(
    rows: readonly T[],
    orderOf: (row: T) => Ordered,
    newestFirst: boolean,
    query: { limit?: number | undefined; cursor?: string | undefined },
    url: URL,
    requestId: string,
    map: (row: T) => unknown = (row) => row,
  ): Response => {
    const hash = queryHash(url.searchParams, ['cursor', 'limit']);
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor, hash);
    if (query.cursor !== undefined && after === null) {
      return problem('INVALID_CURSOR', requestId, [{ field: 'cursor', code: 'invalid_value' }]);
    }
    const result = page(rows, orderOf, newestFirst, limitOf(query.limit), after, hash);
    return ok({ items: result.items.map(map), nextCursor: result.nextCursor }, requestId);
  };
  const idOf = (
    params: Readonly<Record<string, string | readonly string[] | undefined>>,
  ): string => {
    const value = params['id'];
    return typeof value === 'string' ? value : '';
  };

  return [
    route('listMandates', ({ scope, query, url, requestId }) => {
      const rows = fixtures.mandates
        .filter(inScope(scope))
        .filter((m) => query.status === undefined || query.status.includes(m.status));
      return listPage(rows, byCreated, true, query, url, requestId, toMandateListItem);
    }),
    route('getMandate', ({ scope, params, requestId }) => {
      const found = fixtures.mandates.filter(inScope(scope)).find((m) => m.id === idOf(params));
      return found === undefined ? problem('NOT_FOUND', requestId) : ok(found, requestId);
    }),
    route('listPayouts', ({ scope, query, url, requestId }) => {
      const min = query.amountMin === undefined ? null : BigInt(query.amountMin);
      const max = query.amountMax === undefined ? null : BigInt(query.amountMax);
      const from = query.createdFrom === undefined ? null : Date.parse(query.createdFrom);
      const to = query.createdTo === undefined ? null : Date.parse(query.createdTo);
      const rows = fixtures.payouts.filter(inScope(scope)).filter((p) => {
        if (query.status !== undefined && !query.status.includes(p.status)) return false;
        if (
          query.corridor !== undefined &&
          (p.corridor === null || !query.corridor.includes(p.corridor))
        )
          return false;
        if (query.method !== undefined && !query.method.includes(p.method)) return false;
        if (query.mandateId !== undefined && !query.mandateId.includes(p.mandate.id)) return false;
        if (
          query.network !== undefined &&
          (p.network === null || !query.network.includes(p.network))
        )
          return false;
        if (query.amountCurrency !== undefined) {
          if (p.requested.currency !== query.amountCurrency) return false;
          const amount = BigInt(p.requested.amount);
          if (min !== null && amount < min) return false;
          if (max !== null && amount > max) return false;
        }
        const created = Date.parse(p.createdAt);
        if (from !== null && created < from) return false;
        if (to !== null && created > to) return false;
        return true;
      });
      return listPage(rows, byCreated, true, query, url, requestId, toPayoutListItem);
    }),
    route('getPayout', ({ scope, params, requestId }) => {
      const found = fixtures.payouts.filter(inScope(scope)).find((p) => p.id === idOf(params));
      return found === undefined ? problem('NOT_FOUND', requestId) : ok(found, requestId);
    }),
    route('listReceipts', ({ scope, query, url, requestId }) => {
      const rows = fixtures.receipts
        .filter(inScope(scope))
        .filter((r) => query.payoutId === undefined || r.payoutId === query.payoutId);
      return listPage(
        rows,
        (r) => ({ key: r.issuedAt, id: r.id }),
        true,
        query,
        url,
        requestId,
        toReceiptListItem,
      );
    }),
    route('getReceipt', ({ scope, params, request, requestId }) => {
      const index = fixtures.receipts.findIndex((r) => inScope(scope)(r) && r.id === idOf(params));
      const found = fixtures.receipts[index];
      if (found === undefined) return problem('NOT_FOUND', requestId);
      if (request.headers.get(MOCK_VIEW_HEADER) === 'recipient') {
        const view = fixtures.recipientReceipts[index];
        return view === undefined ? problem('NOT_FOUND', requestId) : ok(view, requestId);
      }
      return ok(found, requestId);
    }),
    route('getFunding', ({ scope, query, url, requestId }) => {
      const overview = fixtures.funding.find(inScope(scope));
      const deposits = fixtures.deposits.filter(inScope(scope));
      const hash = queryHash(url.searchParams, ['depositsCursor', 'depositsLimit']);
      const after =
        query.depositsCursor === undefined ? null : decodeCursor(query.depositsCursor, hash);
      if (query.depositsCursor !== undefined && after === null) {
        return problem('INVALID_CURSOR', requestId, [
          { field: 'depositsCursor', code: 'invalid_value' },
        ]);
      }
      const result = page(
        deposits,
        (d) => ({ key: d.seenAt, id: d.id }),
        true,
        limitOf(query.depositsLimit),
        after,
        hash,
      );
      return ok(
        {
          principalId: scope.principalId,
          projectId: scope.projectId,
          accounts: overview?.accounts ?? [],
          deposits: result,
        },
        requestId,
      );
    }),
    route('getOverviewStats', ({ scope, query, requestId }) => {
      // Seeded from the project, so one project always answers the same
      // numbers and two projects never answer the same ones.
      //
      // The period is honoured; from and to are read and validated but not
      // applied, so a custom range gets the fixture's own window back. That
      // is sound because the response states the window it used, and a
      // client reading those fields sees what it got rather than assuming
      // what it asked for. Serving an arbitrary range would mean generating
      // data for it, which belongs with the endpoint.
      let seed = 7;
      for (let i = 0; i < scope.projectId.length; i += 1) {
        seed = (seed * 31 + scope.projectId.charCodeAt(i)) >>> 0;
      }
      const stats = overviewFixture({
        seed,
        ...(query.period === undefined ? {} : { period: query.period }),
      });
      return ok(
        { ...stats, principalId: scope.principalId, projectId: scope.projectId },
        requestId,
      );
    }),
    route('listApprovals', ({ scope, query, url, requestId }) => {
      const rows = fixtures.approvals
        .filter(inScope(scope))
        .filter((a) => query.mandateId === undefined || query.mandateId.includes(a.mandate.id));
      return listPage(
        rows,
        (a) => ({ key: a.requestedAt, id: a.payoutId }),
        false,
        query,
        url,
        requestId,
      );
    }),
  ];
}
