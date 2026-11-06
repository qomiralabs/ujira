// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Reading one payout. What the principal is charged is the recipient's total plus
// the take, and the take is read from the payout's legs until the fee tables are
// in. The published names are settlement, take and charged.

import { randomUUID } from 'node:crypto';

import { PayoutDetail } from '@ujira/api-schema';
import type { Payout, PayoutView } from '@ujira/db';
import { describe, expect, it } from 'vitest';

import {
  leg,
  memoryPayouts,
  NETWORK,
  ONE_USDC,
  payoutWorld,
  problemOf,
  storedPayout,
  TENANT_A,
  TENANT_B,
  usdc,
  view,
} from './payouts.test-support.js';
import { recipientNames } from './recipient-service.js';
import { memoryRecipientRecords, PERSON, testCipher } from './recipients.test-support.js';

const TX_HASH = 'a'.repeat(64);
const SETTLED_AT = new Date('2026-11-01T10:05:00.000Z');

function settled(overrides: Partial<Payout> = {}): Payout {
  return storedPayout({
    total: usdc(5n * ONE_USDC),
    status: 'settling',
    publicStatus: 'settling',
    allowedBy: 'allowlist_auto',
    approvedAt: SETTLED_AT,
    settledAt: SETTLED_AT,
    ...overrides,
  });
}

function routedView(payout: Payout, extra: Partial<PayoutView> = {}): PayoutView {
  const legStatus = payout.settledAt === null ? 'planned' : 'settled';
  const chainTxHash = payout.settledAt === null ? null : TX_HASH;
  return view(payout, {
    attempt: {
      id: randomUUID(),
      network: NETWORK,
      status: 'executing',
      legCount: 2,
      firstMethod: 'stellar_wallet',
    },
    legs: [
      leg({
        index: 0,
        amount: usdc(3n * ONE_USDC),
        fee: usdc(12_000n),
        status: legStatus,
        chainTxHash,
      }),
      leg({
        index: 1,
        amount: usdc(2n * ONE_USDC),
        fee: usdc(8_000n),
        status: legStatus,
        chainTxHash,
      }),
    ],
    ...extra,
  });
}

async function read(store: ReturnType<typeof memoryPayouts>, id: string, as = 'alpha') {
  const { request } = payoutWorld({ records: store });
  return request('GET', `/v1/payouts/${id}`, undefined, { authorization: `Bearer ${as}` });
}

async function detailOf(response: Response): Promise<PayoutDetail> {
  expect(response.status).toBe(200);
  return PayoutDetail.parse(await response.json());
}

describe('GET /v1/payouts/{id}', () => {
  it('response has total, fee and charged with charged = total + fee', async () => {
    const store = memoryPayouts();
    const payout = settled();
    store.put(TENANT_A, routedView(payout));
    const detail = await detailOf(await read(store, payout.id));
    const token = { asset: 'USDC', network: NETWORK, scale: 7 };
    expect(detail.charges).toEqual({
      settlement: { ...token, amount: '50000000' },
      take: { ...token, amount: '20000' },
      takeBps: 50,
      charged: { ...token, amount: '50020000' },
    });
    expect(detail.settlement).toEqual({ ...token, amount: '50000000' });
  });

  it('shows the legs, the timeline and the rule that allowed it', async () => {
    const store = memoryPayouts();
    const payout = settled();
    store.put(TENANT_A, routedView(payout));
    const detail = await detailOf(await read(store, payout.id));
    expect(detail).toMatchObject({
      status: 'settling',
      allowedBy: 'allowlist_auto',
      network: NETWORK,
      legCount: 2,
      settledAt: SETTLED_AT.toISOString(),
      receipt: null,
    });
    expect(detail.legs.map((one) => [one.index, one.rail, one.status, one.txHash])).toEqual([
      [0, 'stellar.wallet', 'settled', TX_HASH],
      [1, 'stellar.wallet', 'settled', TX_HASH],
    ]);
    expect(detail.legs[0]?.maskedDestination).toBe('GA3D...HES5');
    expect(detail.timeline.map((step) => [step.step, step.at])).toEqual([
      ['requested', payout.createdAt.toISOString()],
      ['approved', SETTLED_AT.toISOString()],
      ['quoted', null],
      ['settled', SETTLED_AT.toISOString()],
      ['delivered', null],
    ]);
  });

  it('has no charges, settlement or legs before it is routed', async () => {
    const store = memoryPayouts();
    const payout = storedPayout({ taskId: 'task-7' });
    store.put(TENANT_A, view(payout));
    const detail = await detailOf(await read(store, payout.id));
    expect(detail).toMatchObject({
      status: 'queued',
      taskId: 'task-7',
      charges: null,
      settlement: null,
      network: null,
      legs: [],
      legCount: 0,
      approvals: { given: 0, required: 0 },
      cashOutBearer: 'recipient',
    });
  });

  it('says why a payout waits', async () => {
    const store = memoryPayouts();
    const payout = storedPayout({ statusReason: 'awaiting_funding' });
    store.put(TENANT_A, view(payout));
    const detail = await detailOf(await read(store, payout.id));
    expect(detail.queuedReason).toBe('awaiting_funding');
  });

  it('names the rule that blocked it', async () => {
    const store = memoryPayouts();
    const payout = storedPayout({
      status: 'blocked',
      publicStatus: 'blocked',
      blockedBy: 'DAILY_CAP_EXCEEDED',
    });
    store.put(TENANT_A, view(payout));
    const detail = await detailOf(await read(store, payout.id));
    expect(detail).toMatchObject({ status: 'blocked', blockedBy: 'DAILY_CAP_EXCEEDED' });
  });

  it('links the receipt of a paid payout', async () => {
    const store = memoryPayouts();
    const payout = settled({
      status: 'paid',
      publicStatus: 'paid',
      deliveredAt: new Date('2026-11-01T10:06:00.000Z'),
    });
    store.put(
      TENANT_A,
      routedView(payout, {
        legs: routedView(payout).legs.map((one) => ({ ...one, status: 'delivered' })),
      }),
    );
    const receipt = {
      id: randomUUID(),
      receiptNumber: 'R-0123456789AB',
      receiptRef: `ujira:tx:v1:stellar:testnet:${TX_HASH}:0`,
    };
    const { request } = payoutWorld({
      records: store,
      receipts: (tenant, payoutId) =>
        Promise.resolve(
          tenant.principalId === TENANT_A.principalId &&
            tenant.projectId === TENANT_A.projectId &&
            payoutId === payout.id
            ? receipt
            : null,
        ),
    });
    const detail = await detailOf(await request('GET', `/v1/payouts/${payout.id}`));
    expect(detail.receipt).toEqual(receipt);
    expect(detail.legs.every((one) => one.deliveredAt !== null)).toBe(true);
  });

  it('shows a recipient-mode amount in US dollars, at par', async () => {
    const store = memoryPayouts();
    const payout = storedPayout({ requested: usdc(123_400_000n) });
    store.put(TENANT_A, view(payout));
    const detail = await detailOf(await read(store, payout.id));
    expect(detail.requested).toEqual({ amount: '1234', currency: 'USD', scale: 2 });
  });

  it("answers another tenant's payout as one that does not exist", async () => {
    const store = memoryPayouts();
    const payout = storedPayout();
    store.put(TENANT_B, view(payout));
    const response = await read(store, payout.id);
    expect(response.status).toBe(404);
    expect((await problemOf(response)).code).toBe('NOT_FOUND');
  });

  it('answers a malformed id as not found', async () => {
    const response = await read(memoryPayouts(), 'not-a-uuid');
    expect(response.status).toBe(404);
  });

  it('answers 500 for a paid payout whose receipt cannot be found, rather than leave it out', async () => {
    const store = memoryPayouts();
    const payout = settled({
      status: 'paid',
      publicStatus: 'paid',
      deliveredAt: new Date('2026-11-01T10:06:00.000Z'),
    });
    store.put(TENANT_A, routedView(payout));
    const response = await read(store, payout.id);
    expect(response.status).toBe(500);
  });
});

describe('the name a payout shows for its recipient', () => {
  it('is the registered name, decrypted, or a label when none was given', async () => {
    const records = memoryRecipientRecords();
    const cipher = testCipher();
    const signal = new AbortController().signal;
    const named = randomUUID();
    const sealed = await cipher.encrypt(
      TENANT_A,
      named,
      new TextEncoder().encode(JSON.stringify(PERSON)),
      signal,
    );
    await records.createOnce(TENANT_A, {
      id: named,
      recipientRef: Buffer.alloc(32, 1),
      country: 'NG',
      personal: sealed,
    });
    const unnamed = randomUUID();
    await records.createOnce(TENANT_A, {
      id: unnamed,
      recipientRef: Buffer.alloc(32, 2),
      country: 'KE',
      personal: null,
    });
    const names = await recipientNames(records, cipher)(TENANT_A, [named, unnamed], signal);
    expect(names.get(named)).toBe(PERSON.fullName);
    expect(names.get(unnamed)).toBe(`Recipient ${unnamed.slice(0, 8)}`);
  });

  it("does not read another tenant's recipient", async () => {
    const records = memoryRecipientRecords();
    const cipher = testCipher();
    const signal = new AbortController().signal;
    const id = randomUUID();
    const sealed = await cipher.encrypt(
      TENANT_B,
      id,
      new TextEncoder().encode(JSON.stringify(PERSON)),
      signal,
    );
    await records.createOnce(TENANT_B, {
      id,
      recipientRef: Buffer.alloc(32, 3),
      country: 'NG',
      personal: sealed,
    });
    const names = await recipientNames(records, cipher)(TENANT_A, [id], signal);
    expect(names.get(id)).toBe(`Recipient ${id.slice(0, 8)}`);
    expect(cipher.decrypted()).toBe(0);
  });
});
