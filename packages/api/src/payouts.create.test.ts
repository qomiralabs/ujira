// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Creating a payout. The answer is quick and says queued; the payout runs in the
// worker from a job written in the same transaction as the payout. A retry never
// makes a second payout, even after the process died between its write and its
// answer, because the payout carries the key under a unique constraint of its own.

import { randomBytes, randomUUID } from 'node:crypto';

import { PayoutAccepted } from '@ujira/api-schema';
import {
  entryPoints,
  IdempotencyConflictError,
  mandateInstances,
  mandates,
  payoutMethods,
  payouts,
  recipients,
} from '@ujira/db';
import type { Database, Payout } from '@ujira/db';
import { createTestDatabase, databaseAsServiceRoles } from '@ujira/db/testing';
import type { TestDatabase } from '@ujira/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Tenant } from './auth.js';
import { memoryIdempotencyStore } from './idempotency.js';
import type { IdempotencyStore } from './idempotency.js';
import type { PayoutRecords } from './payout-service.js';
import {
  knownParties,
  memoryPayouts,
  payoutWorld,
  problemOf,
  TEN_DOLLARS,
  TENANT_A,
  TENANT_B,
  usd,
} from './payouts.test-support.js';
import { databasePayoutRecords } from './postgres-stores.js';
import type { PayoutScheduler } from './postgres-stores.js';
import { PAYOUTS_NOT_CONFIGURED, payoutRoutes } from './routes/payouts.js';

declare module 'vitest' {
  interface ProvidedContext {
    dbAdminUrl: string;
    dbRoleUrls: Record<string, string>;
  }
}

const KEY = 'idempotency-key';

describe('POST /v1/payouts', () => {
  it('answers 202 queued with what was asked for, and nothing personal', async () => {
    const store = memoryPayouts();
    const { request } = payoutWorld({ records: store });
    const parties = knownParties(store);
    const response = await request('POST', '/v1/payouts', {
      ...parties,
      amount: TEN_DOLLARS,
      taskId: 'task-42',
    });
    expect(response.status).toBe(202);
    const body = PayoutAccepted.parse(await response.json());
    expect(body).toMatchObject({
      ...TENANT_A,
      ...parties,
      status: 'queued',
      requested: TEN_DOLLARS,
      method: 'stellar_wallet',
      taskId: 'task-42',
    });
    expect(store.scheduled).toEqual([{ tenant: TENANT_A, payoutId: body.id }]);
  });

  it('retry with the same key returns the same payout', async () => {
    const store = memoryPayouts();
    const { request } = payoutWorld({ records: store });
    const body = { ...knownParties(store), amount: TEN_DOLLARS };
    const key = randomUUID();
    const first = await request('POST', '/v1/payouts', body, { [KEY]: key });
    const second = await request('POST', '/v1/payouts', body, { [KEY]: key });
    expect(second.status).toBe(202);
    const a = PayoutAccepted.parse(await first.json());
    const b = PayoutAccepted.parse(await second.json());
    expect(b.id).toBe(a.id);
    expect(store.scheduled).toHaveLength(1);
  });

  it('a different key makes a different payout', async () => {
    const store = memoryPayouts();
    const { request } = payoutWorld({ records: store });
    const body = { ...knownParties(store), amount: TEN_DOLLARS };
    const a = PayoutAccepted.parse(await (await request('POST', '/v1/payouts', body)).json());
    const b = PayoutAccepted.parse(await (await request('POST', '/v1/payouts', body)).json());
    expect(b.id).not.toBe(a.id);
    expect(store.scheduled).toHaveLength(2);
  });

  it('pays nothing twice when the process dies after its write and the lease runs out', async () => {
    const store = memoryPayouts();
    let die = true;
    const dying: PayoutRecords = {
      ...store,
      create: async (tenant, input) => {
        const written = await store.create(tenant, input);
        if (die) {
          die = false;
          throw new Error('the process died after its write');
        }
        return written;
      },
    };
    let now = Date.parse('2026-11-05T12:00:00Z');
    const inner = memoryIdempotencyStore(() => new Date(now));
    // A dead process releases nothing, so the key stays leased until it runs out.
    const idempotency: IdempotencyStore = { ...inner, release: () => Promise.resolve(false) };
    const { request } = payoutWorld({ records: dying, idempotency });
    const body = { ...knownParties(store), amount: TEN_DOLLARS };
    const key = randomUUID();

    const died = await request('POST', '/v1/payouts', body, { [KEY]: key });
    expect(died.status).toBe(500);
    expect(store.scheduled).toHaveLength(1);

    const early = await request('POST', '/v1/payouts', body, { [KEY]: key });
    expect((await problemOf(early)).code).toBe('IDEMPOTENCY_IN_PROGRESS');

    now += 121_000;
    const retried = await request('POST', '/v1/payouts', body, { [KEY]: key });
    expect(retried.status).toBe(202);
    const { id } = PayoutAccepted.parse(await retried.json());
    expect(store.scheduled).toEqual([{ tenant: TENANT_A, payoutId: id }]);
    expect(store.views.size).toBe(1);
  });

  it('refuses the same key with another payout, and makes nothing', async () => {
    const store = memoryPayouts();
    const { request } = payoutWorld({ records: store });
    const parties = knownParties(store);
    const key = randomUUID();
    await request('POST', '/v1/payouts', { ...parties, amount: TEN_DOLLARS }, { [KEY]: key });
    const other = await request(
      'POST',
      '/v1/payouts',
      { ...parties, amount: { ...TEN_DOLLARS, amount: '2000' } },
      { [KEY]: key },
    );
    expect(other.status).toBe(422);
    expect((await problemOf(other)).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(store.scheduled).toHaveLength(1);
  });

  it('needs an Idempotency-Key', async () => {
    const store = memoryPayouts();
    const { app } = payoutWorld({ records: store });
    const response = await app.request('/v1/payouts', {
      method: 'POST',
      headers: { authorization: 'Bearer alpha', 'content-type': 'application/json' },
      body: JSON.stringify({ ...knownParties(store), amount: TEN_DOLLARS }),
    });
    expect((await problemOf(response)).code).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(store.scheduled).toEqual([]);
  });

  it.each([
    ['a recipient it does not know', 'recipient'],
    ['a mandate it does not know', 'mandate'],
  ] as const)('answers 404 for %s', async (_name, missing) => {
    const store = memoryPayouts();
    const { request } = payoutWorld({ records: store });
    const parties = knownParties(store);
    const response = await request('POST', '/v1/payouts', {
      ...parties,
      ...(missing === 'recipient' ? { recipientId: randomUUID() } : { mandateId: randomUUID() }),
      amount: TEN_DOLLARS,
    });
    expect(response.status).toBe(404);
    expect(store.scheduled).toEqual([]);
  });

  it("answers another tenant's recipient as one that does not exist", async () => {
    const store = memoryPayouts();
    const { request } = payoutWorld({ records: store });
    const theirs = knownParties(store, TENANT_B);
    const response = await request('POST', '/v1/payouts', { ...theirs, amount: TEN_DOLLARS });
    expect(response.status).toBe(404);
    expect(store.scheduled).toEqual([]);
  });

  it('refuses a recipient that cannot be paid that way', async () => {
    const store = memoryPayouts();
    const { request } = payoutWorld({ records: store });
    const parties = knownParties(store);
    const response = await request('POST', '/v1/payouts', {
      ...parties,
      amount: TEN_DOLLARS,
      method: 'bank',
    });
    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe('DESTINATION_INVALID');
  });

  it('refuses a suspended recipient', async () => {
    const store = memoryPayouts();
    const { request } = payoutWorld({ records: store });
    const parties = knownParties(store, TENANT_A, { active: false });
    const response = await request('POST', '/v1/payouts', { ...parties, amount: TEN_DOLLARS });
    expect(response.status).toBe(422);
    expect((await problemOf(response)).code).toBe('DESTINATION_INVALID');
  });

  it('refuses an amount in a unit this project does not ask in', async () => {
    const store = memoryPayouts();
    const { request } = payoutWorld({ records: store });
    const response = await request('POST', '/v1/payouts', {
      ...knownParties(store),
      amount: { amount: '150000', currency: 'NGN', scale: 2 },
    });
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('INVALID_AMOUNT');
  });

  it.each([
    ['an amount as a number', { amount: 1000, currency: 'USD', scale: 2 }],
    ['an amount with a decimal point', { amount: '10.00', currency: 'USD', scale: 2 }],
    ['a split, which is not offered yet', null],
  ])('refuses %s as a 400', async (_name, amount) => {
    const store = memoryPayouts();
    const { request } = payoutWorld({ records: store });
    const response = await request('POST', '/v1/payouts', {
      ...knownParties(store),
      amount: amount ?? TEN_DOLLARS,
      ...(amount === null ? { split: [{ share: 1 }] } : {}),
    });
    expect(response.status).toBe(400);
    expect(store.scheduled).toEqual([]);
  });

  it('takes from the payout creation bucket as well as the key and principal ones', () => {
    const route = payoutRoutes(PAYOUTS_NOT_CONFIGURED).find((one) => one.id === 'createPayout');
    expect(route?.access).toEqual({
      kind: 'tenant',
      scope: 'payouts:write',
      rateLimit: 'payout_creation',
    });
  });

  it('answers 503 until the worker queue is wired, and takes nothing', async () => {
    const { request } = payoutWorld({ endpoints: PAYOUTS_NOT_CONFIGURED });
    const response = await request('POST', '/v1/payouts', {
      recipientId: randomUUID(),
      mandateId: randomUUID(),
      amount: TEN_DOLLARS,
    });
    expect(response.status).toBe(503);
  });

  it('refuses a task id that could carry anything but an id', async () => {
    const store = memoryPayouts();
    const { request } = payoutWorld({ records: store });
    const response = await request('POST', '/v1/payouts', {
      ...knownParties(store),
      amount: TEN_DOLLARS,
      taskId: 'pay Ada Lovelace',
    });
    expect(response.status).toBe(400);
  });
});

// The same create on the real tables, as the role the API runs as.
describe('against the database', () => {
  const adminUrl = inject('dbAdminUrl');
  const roleUrls = inject('dbRoleUrls');

  let database: TestDatabase;
  let db: Database;
  let tenant: Tenant;
  let recipientId: string;
  let mandateId: string;

  beforeAll(async () => {
    database = await createTestDatabase(adminUrl, import.meta.url);
    db = databaseAsServiceRoles(roleUrls, database, 4);
    tenant = await db.unscoped((tx) =>
      entryPoints.createPrincipal(tx, {
        name: 'A',
        projectName: 'Main',
        ownerUserId: randomUUID(),
      }),
    );
    ({ recipientId, mandateId } = await db.tenant(tenant).transaction(async (tx) => {
      const recipient = await recipients.create(tx, {
        recipientRef: randomBytes(32),
        country: 'NG',
      });
      await payoutMethods.create(tx, {
        recipientId: recipient.id,
        method: 'stellar_wallet',
        rail: 'wallet',
        chain: 'stellar',
        destinationAddress: `G${randomUUID()}`,
        destinationTag: null,
        details: null,
      });
      const mandate = await mandates.create(tx, { name: 'Payroll' });
      await mandateInstances.create(tx, {
        mandateId: mandate.id,
        chain: 'stellar',
        network: 'stellar:testnet',
        contractAddress: `C${randomUUID()}`,
        specVersion: '1',
        asset: 'USDC',
        scale: 7,
      });
      return { recipientId: recipient.id, mandateId: mandate.id };
    }));
  });

  afterAll(async () => {
    await db.close();
    await database.drop();
  });

  // The key is unique per project, so a key holds one payout or none.
  async function payoutsWithKey(key: string): Promise<number> {
    const found = await db.tenant(tenant).transaction((tx) => payouts.findByKey(tx, key));
    return found === undefined ? 0 : 1;
  }

  const request = (key: string) => ({
    idempotencyKey: key,
    mandateId,
    recipientId,
    amount: usd(1000n),
    method: null,
    taskId: null,
  });

  it('payout and job are written in one transaction', async () => {
    const seen: { payout: Payout; visibleOutside: boolean }[] = [];
    const schedule: PayoutScheduler = async (tx, payout) => {
      // The job sees the payout inside its transaction, and another connection
      // does not see it yet, so the two can only commit together.
      const inside = await payouts.get(tx, payout.id);
      const outside = await db.tenant(tenant).transaction((other) => payouts.get(other, payout.id));
      expect(inside?.id).toBe(payout.id);
      seen.push({ payout, visibleOutside: outside !== undefined });
    };
    const key = randomUUID();
    const created = await databasePayoutRecords(db, schedule).create(tenant, request(key));
    expect(created.outcome).toBe('created');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.visibleOutside).toBe(false);
    expect(await payoutsWithKey(key)).toBe(1);
  });

  it('writes no payout when its job cannot be written', async () => {
    const failing: PayoutScheduler = () => Promise.reject(new Error('the queue refused the job'));
    const key = randomUUID();
    await expect(databasePayoutRecords(db, failing).create(tenant, request(key))).rejects.toThrow(
      'the queue refused the job',
    );
    expect(await payoutsWithKey(key)).toBe(0);
  });

  it('schedules nothing on a retry, and the retry finds the first payout', async () => {
    let jobs = 0;
    const store = databasePayoutRecords(db, () => {
      jobs += 1;
      return Promise.resolve();
    });
    const key = randomUUID();
    const first = await store.create(tenant, request(key));
    const again = await store.create(tenant, request(key));
    expect(again).toMatchObject({ outcome: 'existing' });
    if (first.outcome !== 'created' || again.outcome !== 'existing') throw new Error('no payout');
    expect(again.payout.id).toBe(first.payout.id);
    expect(jobs).toBe(1);
  });

  it('makes one payout and one job when two creates race on a key', async () => {
    let jobs = 0;
    const store = databasePayoutRecords(db, () => {
      jobs += 1;
      return Promise.resolve();
    });
    const key = randomUUID();
    const outcomes = await Promise.all([
      store.create(tenant, request(key)),
      store.create(tenant, request(key)),
      store.create(tenant, request(key)),
    ]);
    expect(outcomes.filter((outcome) => outcome.outcome === 'created')).toHaveLength(1);
    expect(await payoutsWithKey(key)).toBe(1);
    expect(jobs).toBe(1);
  });

  it('pays nothing twice when the process dies after its write and the lease runs out', async () => {
    let jobs = 0;
    const store = databasePayoutRecords(db, () => {
      jobs += 1;
      return Promise.resolve();
    });
    let die = true;
    const dying: PayoutRecords = {
      ...store,
      create: async (who, input) => {
        const written = await store.create(who, input);
        if (die) {
          die = false;
          throw new Error('the process died after its write');
        }
        return written;
      },
    };
    let now = Date.parse('2026-11-05T12:00:00Z');
    const inner = memoryIdempotencyStore(() => new Date(now));
    const idempotency: IdempotencyStore = { ...inner, release: () => Promise.resolve(false) };
    const world = payoutWorld({ records: dying, idempotency, as: tenant });
    const key = randomUUID();
    const send = () =>
      world.request(
        'POST',
        '/v1/payouts',
        { recipientId, mandateId, amount: TEN_DOLLARS },
        {
          [KEY]: key,
        },
      );
    expect((await send()).status).toBe(500);
    now += 121_000;
    const retried = await send();
    expect(retried.status).toBe(202);
    expect(await payoutsWithKey(key)).toBe(1);
    expect(jobs).toBe(1);
  });

  it('refuses the same key for another payout, and schedules nothing', async () => {
    let jobs = 0;
    const store = databasePayoutRecords(db, () => {
      jobs += 1;
      return Promise.resolve();
    });
    const key = randomUUID();
    await store.create(tenant, request(key));
    for (const other of [
      { amount: usd(2000n) },
      { taskId: 'another-task' },
      { method: 'bank' as const },
    ]) {
      await expect(store.create(tenant, { ...request(key), ...other })).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    }
    expect(jobs).toBe(1);
  });

  it("cannot pay another tenant's recipient", async () => {
    const other = await db.unscoped((tx) =>
      entryPoints.createPrincipal(tx, {
        name: 'B',
        projectName: 'Main',
        ownerUserId: randomUUID(),
      }),
    );
    const store = databasePayoutRecords(db, () => Promise.resolve());
    const outcome = await store.create(other, request(randomUUID()));
    expect(outcome.outcome).toBe('recipient_not_found');
  });

  it('asks in US dollars and stores USDC at par for a project whose recipients bear the cost', async () => {
    const store = databasePayoutRecords(db, () => Promise.resolve());
    const outcome = await store.create(tenant, request(randomUUID()));
    if (outcome.outcome !== 'created') throw new Error('no payout');
    expect(outcome.payout.requested).toMatchObject({
      kind: 'token',
      asset: 'USDC',
      amount: 100_000_000n,
    });
  });
});
