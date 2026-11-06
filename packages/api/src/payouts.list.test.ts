// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Listing payouts a page at a time. The cursor is signed and bound to the caller
// and the filters, so it can only be handed back as it was given.

import { PayoutPage } from '@ujira/api-schema';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  memoryPayouts,
  payoutWorld,
  problemOf,
  storedPayout,
  TENANT_A,
  TENANT_B,
  view,
} from './payouts.test-support.js';
import type { MemoryPayouts } from './payouts.test-support.js';

function seeded(count: number): MemoryPayouts {
  const store = memoryPayouts();
  // Two share a second, so only the id orders them.
  for (let i = 0; i < count; i += 1) {
    const createdAt = new Date(Date.parse('2026-11-01T10:00:00Z') + Math.floor(i / 2) * 1000);
    store.put(TENANT_A, view(storedPayout({ createdAt })));
  }
  return store;
}

async function pageOf(response: Response): Promise<z.infer<typeof PayoutPage>> {
  expect(response.status).toBe(200);
  return PayoutPage.parse(await response.json());
}

async function readAll(
  request: ReturnType<typeof payoutWorld>['request'],
  query: string,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const suffix: string = cursor === null ? '' : `&cursor=${cursor}`;
    const page = await pageOf(await request('GET', `/v1/payouts?${query}${suffix}`));
    seen.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return seen;
}

function newestFirst(store: MemoryPayouts): string[] {
  return [...store.views.values()]
    .filter((entry) => entry.tenant === `${TENANT_A.principalId}:${TENANT_A.projectId}`)
    .map((entry) => entry.view.position)
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    )
    .map((position) => position.id);
}

describe('GET /v1/payouts', () => {
  it('cursor pages never repeat or skip', async () => {
    const store = seeded(9);
    const { request } = payoutWorld({ records: store });
    const expected = newestFirst(store);
    for (const limit of [1, 2, 4, 9, 50]) {
      expect(await readAll(request, `limit=${String(limit)}`), String(limit)).toEqual(expected);
    }
  });

  it("lists only the caller's payouts", async () => {
    const store = seeded(3);
    const theirs = storedPayout();
    store.put(TENANT_B, view(theirs));
    const { request } = payoutWorld({ records: store });
    const page = await pageOf(await request('GET', '/v1/payouts'));
    expect(page.items.map((item) => item.id)).not.toContain(theirs.id);
    expect(page.items.every((item) => item.principalId === TENANT_A.principalId)).toBe(true);
  });

  it('refuses a cursor with other filters than the ones that made it', async () => {
    const { request } = payoutWorld({ records: seeded(4) });
    const first = await pageOf(await request('GET', '/v1/payouts?limit=1&status=queued'));
    const response = await request(
      'GET',
      `/v1/payouts?limit=1&status=cancelled&cursor=${String(first.nextCursor)}`,
    );
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('INVALID_CURSOR');
  });

  it('takes the same cursor with another page size', async () => {
    const { request } = payoutWorld({ records: seeded(4) });
    const first = await pageOf(await request('GET', '/v1/payouts?limit=1'));
    const rest = await pageOf(
      await request('GET', `/v1/payouts?limit=3&cursor=${String(first.nextCursor)}`),
    );
    expect(rest.items).toHaveLength(3);
  });

  it("refuses another tenant's cursor", async () => {
    const { request } = payoutWorld({ records: seeded(4) });
    const first = await pageOf(await request('GET', '/v1/payouts?limit=1'));
    const response = await request(
      'GET',
      `/v1/payouts?limit=1&cursor=${String(first.nextCursor)}`,
      undefined,
      { authorization: 'Bearer bravo' },
    );
    expect((await problemOf(response)).code).toBe('INVALID_CURSOR');
  });

  it('refuses a cursor that was changed', async () => {
    const { request } = payoutWorld({ records: seeded(4) });
    const first = await pageOf(await request('GET', '/v1/payouts?limit=1'));
    const cursor = String(first.nextCursor);
    const last = cursor.at(-1) === 'A' ? 'B' : 'A';
    const response = await request(
      'GET',
      `/v1/payouts?limit=1&cursor=${cursor.slice(0, -1)}${last}`,
    );
    expect((await problemOf(response)).code).toBe('INVALID_CURSOR');
  });

  it('refuses a cursor from another server key', async () => {
    const store = seeded(4);
    const one = payoutWorld({ records: store });
    const other = payoutWorld({ records: store });
    const first = await pageOf(await one.request('GET', '/v1/payouts?limit=1'));
    const response = await other.request(
      'GET',
      `/v1/payouts?limit=1&cursor=${String(first.nextCursor)}`,
    );
    expect((await problemOf(response)).code).toBe('INVALID_CURSOR');
  });

  it('filters by status, and says there is nothing more on the last page', async () => {
    const store = seeded(2);
    const cancelled = storedPayout({ status: 'cancelled', publicStatus: 'cancelled' });
    store.put(TENANT_A, view(cancelled));
    const { request } = payoutWorld({ records: store });
    const page = await pageOf(await request('GET', '/v1/payouts?status=cancelled'));
    expect(page.items.map((item) => item.id)).toEqual([cancelled.id]);
    expect(page.nextCursor).toBeNull();
  });

  it('shows each payout as the contract lists it', async () => {
    const store = memoryPayouts();
    const payout = storedPayout();
    store.put(TENANT_A, view(payout));
    const { request } = payoutWorld({ records: store });
    const page = await pageOf(await request('GET', '/v1/payouts'));
    expect(page.items[0]).toMatchObject({
      ...TENANT_A,
      id: payout.id,
      recipient: { id: payout.recipientId, country: 'NG' },
      mandate: { id: payout.mandateId, name: 'Payroll' },
      requested: { amount: '500', currency: 'USD', scale: 2 },
      status: 'queued',
      settlement: null,
      network: null,
      legCount: 0,
      corridor: 'NG',
      method: 'stellar_wallet',
    });
  });

  it('refuses a filter the contract does not know', async () => {
    const { request } = payoutWorld({ records: seeded(1) });
    const response = await request('GET', '/v1/payouts?colour=blue');
    expect(response.status).toBe(400);
  });
});
