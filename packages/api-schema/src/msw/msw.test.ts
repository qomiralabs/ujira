// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { setupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TenantScope } from '../common.js';
import { assertResponseMatchesSchema } from '../contract.js';
import { Problem } from '../envelope.js';
import { generateFixtures } from '../fixtures/index.js';
import { ROUTES, ROUTE_IDS } from '../routes.js';
import type { RouteId } from '../routes.js';
import { MOCK_VIEW_HEADER, createHandlers } from './index.js';

const BASE = 'http://mock.example';
const fixtures = generateFixtures({ seed: 42, payouts: 600, edge: true });
const [home, sibling, other] = fixtures.tenants;
if (home === undefined || sibling === undefined || other === undefined)
  throw new Error('fixture tenants missing');

// Each request names its tenant in a mock-only header, so one server can
// act as any of them.
const TENANT_HEADER = 'x-test-tenant';
const tenants = new Map<string, TenantScope>([
  ['home', home],
  ['sibling', sibling],
  ['other', other],
]);
const server = setupServer(
  ...createHandlers({
    fixtures,
    baseUrl: BASE,
    scope: (request) => tenants.get(request.headers.get(TENANT_HEADER) ?? '') ?? null,
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});

const get = (
  path: string,
  tenant = 'home',
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${BASE}${path}`, { headers: { [TENANT_HEADER]: tenant, ...headers } });

function homeId(route: RouteId): string {
  const ids: Partial<Record<RouteId, string | undefined>> = {
    getMandate: fixtures.mandates.find((m) => m.projectId === home?.projectId)?.id,
    getPayout: fixtures.payouts.find((p) => p.projectId === home?.projectId)?.id,
    getReceipt: fixtures.receipts.find((r) => r.projectId === home?.projectId)?.id,
  };
  return ids[route] ?? '';
}

const pathOf = (route: RouteId): string => ROUTES[route].path.replace('{id}', homeId(route));

async function problemOf(response: Response): Promise<Problem> {
  return Problem.parse(await response.json());
}

describe('mock handlers', () => {
  it('every handler response parses with its route schema', async () => {
    for (const route of ROUTE_IDS) {
      const response = await get(pathOf(route));
      expect(response.status, route).toBe(200);
      await assertResponseMatchesSchema(route, response);
    }
    // The recipient view of a receipt is served by the same route.
    const view = await get(pathOf('getReceipt'), 'home', { [MOCK_VIEW_HEADER]: 'recipient' });
    const body = (await assertResponseMatchesSchema('getReceipt', view)) as { view: string };
    expect(body.view).toBe('recipient');
  });

  it('walks every payout of a tenant once through the keyset pages', async () => {
    const expected = fixtures.payouts
      .filter((p) => p.projectId === home.projectId)
      .map((p) => p.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limit=37' : `?limit=37&cursor=${cursor}`;
      const response = await get(`/v1/payouts${query}`);
      const page = (await assertResponseMatchesSchema('listPayouts', response)) as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      seen.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(expected);
  });

  it('applies every filter', async () => {
    const response = await get(
      '/v1/payouts?status=paid,delivering&method=bank&amountCurrency=USD&amountMin=1000&amountMax=400000&limit=200',
    );
    const page = (await assertResponseMatchesSchema('listPayouts', response)) as {
      items: { status: string; method: string; requested: { amount: string; currency: string } }[];
    };
    expect(page.items.length).toBeGreaterThan(0);
    for (const p of page.items) {
      expect(['paid', 'delivering']).toContain(p.status);
      expect(p.method).toBe('bank');
      expect(p.requested.currency).toBe('USD');
      expect(BigInt(p.requested.amount) >= 1000n && BigInt(p.requested.amount) <= 400000n).toBe(
        true,
      );
    }
    const corridor = (await assertResponseMatchesSchema(
      'listPayouts',
      await get('/v1/payouts?corridor=NG&limit=200'),
    )) as {
      items: { corridor: string | null }[];
    };
    expect(corridor.items.every((p) => p.corridor === 'NG')).toBe(true);
  });

  it('never shows another tenant: foreign ids are not found and lists stay scoped', async () => {
    for (const route of ['getMandate', 'getPayout', 'getReceipt'] as const) {
      for (const tenant of ['sibling', 'other']) {
        const response = await get(pathOf(route), tenant);
        expect(response.status, `${route} as ${tenant}`).toBe(404);
        expect((await problemOf(response)).code).toBe('NOT_FOUND');
      }
    }
    for (const route of ROUTE_IDS.filter((r) => !r.startsWith('get') || r === 'getFunding')) {
      const response = await get(ROUTES[route].path, 'other');
      const text = await response.text();
      expect(text, route).not.toContain(home.projectId);
      expect(text, route).not.toContain(home.principalId);
    }
  });

  it('answers with problems the contract allows', async () => {
    const cases: [string, number, string][] = [
      ['/v1/payouts?limit=500', 400, 'LIMIT_OUT_OF_RANGE'],
      ['/v1/payouts?cursor=not-a-cursor', 400, 'INVALID_CURSOR'],
      ['/v1/payouts?colour=blue', 400, 'INVALID_FILTER'],
      ['/v1/payouts?status=shipped', 400, 'INVALID_FILTER'],
      ['/v1/payouts?amountCurrency=USD&amountMin=9&amountMax=1', 400, 'INVALID_FILTER'],
      ['/v1/payouts?status=paid&status=failed', 400, 'INVALID_FILTER'],
      ['/v1/funding?depositsCursor=bad', 400, 'INVALID_CURSOR'],
      ['/v1/payouts/00000000-0000-4000-8000-000000000000', 404, 'NOT_FOUND'],
    ];
    for (const [path, status, code] of cases) {
      const response = await get(path);
      const route = path.startsWith('/v1/funding')
        ? 'getFunding'
        : path.includes('/v1/payouts/')
          ? 'getPayout'
          : 'listPayouts';
      expect(response.status, path).toBe(status);
      const body = (await assertResponseMatchesSchema(route, response)) as Problem;
      expect(body.code, path).toBe(code);
    }
    const unknown = await problemOf(await get('/v1/payouts?colour=blue'));
    expect(unknown.errors).toEqual([{ field: 'colour', code: 'unknown_field' }]);
    const inverted = await problemOf(
      await get('/v1/payouts?amountCurrency=USD&amountMin=9&amountMax=1'),
    );
    expect(inverted.errors).toEqual([{ field: 'amountMin', code: 'range_inverted' }]);
    const anonymous = await fetch(`${BASE}/v1/payouts`);
    expect(anonymous.status).toBe(401);
    await assertResponseMatchesSchema('listPayouts', anonymous);
  });

  it('refuses a cursor reused with a different filter', async () => {
    const first = (await (await get('/v1/payouts?limit=5&status=paid')).json()) as {
      nextCursor: string | null;
    };
    expect(first.nextCursor).not.toBeNull();
    const reused = await get(
      `/v1/payouts?limit=5&status=failed&cursor=${String(first.nextCursor)}`,
    );
    expect(reused.status).toBe(400);
    expect((await problemOf(reused)).code).toBe('INVALID_CURSOR');
  });

  it('pages deposits and approvals in their own order', async () => {
    const funding = (await (await get('/v1/funding?depositsLimit=3')).json()) as {
      deposits: { items: { seenAt: string }[]; nextCursor: string | null };
    };
    expect(funding.deposits.items).toHaveLength(3);
    expect(funding.deposits.nextCursor).not.toBeNull();
    const next = await get(
      `/v1/funding?depositsLimit=3&depositsCursor=${String(funding.deposits.nextCursor)}`,
    );
    const later = (await assertResponseMatchesSchema('getFunding', next)) as {
      deposits: { items: { seenAt: string }[] };
    };
    const lastSeen = funding.deposits.items[2]?.seenAt ?? '';
    expect(later.deposits.items.every((d) => d.seenAt <= lastSeen)).toBe(true);

    const approvals = (await assertResponseMatchesSchema(
      'listApprovals',
      await get('/v1/approvals?limit=200'),
    )) as {
      items: { requestedAt: string }[];
    };
    const times = approvals.items.map((a) => a.requestedAt);
    expect([...times].sort()).toEqual(times);
  });
});
