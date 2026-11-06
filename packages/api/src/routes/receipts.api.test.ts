// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the receipt routes (routes/receipts.ts).
 *
 * The principal's copy, by receipt or by payout, needs receipts:read, and a
 * receipt of another tenant is 404. A CSV export and a PDF come back as files.
 * The public check needs no key: a wrong code is the same 404 as an unknown
 * number, and the answer carries nothing that belongs to a tenant. Before the
 * tables exist, the served routes answer 503.
 */

import { randomUUID } from 'node:crypto';

import { PublicReceiptVerification } from '@ujira/api-schema';
import { generateFixtures } from '@ujira/api-schema/fixtures';
import type { NetworkId } from '@ujira/chain-adapter';
import { parseMoney, parseTokenAmount } from '@ujira/core';
import { buildReceipt, documentSha256 } from '@ujira/receipts';
import type { Receipt, StoredReceipt } from '@ujira/receipts';
import { expect, test } from 'vitest';

import { createApp } from '../app.js';
import type { Authenticate, Tenant } from '../auth.js';
import { memoryIdempotencyStore } from '../idempotency.js';
import { memoryLogger } from '../log.js';
import { buildOpenApiDocument } from '../openapi.js';
import { allowEveryAddress, allowEveryRequest } from '../rate-limit.js';
import { V1_ROUTES, v1Routes } from './index.js';
import { MANDATES_NOT_CONFIGURED } from './mandates.js';
import { toPrincipalReceipt } from './receipts.js';
import type { PrincipalReceiptRecord, ReceiptExportFilter, ReceiptReads } from './receipts.js';
import { RECIPIENTS_NOT_CONFIGURED } from './recipients.js';
import { SELF_WEBHOOK_NOT_CONFIGURED } from './self-webhook.js';
import { WALLET_PROOF_NOT_CONFIGURED } from './wallet-proofs.js';

const TENANT_A: Tenant = {
  principalId: '0199a1f6-1111-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-2222-7a55-8e21-5b9c7d3e1f04',
};
const TENANT_B: Tenant = {
  principalId: '0199a1f6-9999-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-8888-7a55-8e21-5b9c7d3e1f04',
};
const TOKEN_ID = randomUUID();
const NETWORK: NetworkId = 'stellar:testnet';
const RECEIPT_ID = '0199a1f6-3333-7a55-8e21-5b9c7d3e1f04';
const PAYOUT_ID = '0199a1f6-4444-7a55-8e21-5b9c7d3e1f04';
const CODE = 'ABCDEFGHIJKLMNOPQRST';
const TAG = 4_402_118n;

const usdc = (text: string) => parseTokenAmount(text, 'USDC', 'stellar');
const ref = (char: string) => `ujira:tx:v1:${NETWORK}:${char.repeat(64)}:0`;

function receiptFor(tenant: Tenant): Receipt {
  return buildReceipt({
    principalId: tenant.principalId,
    projectId: tenant.projectId,
    receiptNumber: 'R-7K2M9Q4X8B1C',
    revision: 1,
    supersedes: null,
    issuedAt: '2026-10-31T09:15:00.000Z',
    payoutId: PAYOUT_ID,
    taskId: 'annotation-batch-118',
    mandate: { id: '8f4e2b6a-1c3d-4a7e-9b5f-0d2c6e8a4f13', name: 'Contributors' },
    recipientRef: 'a'.repeat(64),
    network: NETWORK,
    receiptRef: ref('f'),
    requested: parseMoney('480000', 'NGN'),
    total: usdc('306'),
    fee: { amount: usdc('1.53'), bps: 50 },
    feeRefunds: [{ amount: usdc('0.5'), receiptRef: ref('9') }],
    legs: [
      {
        index: 0,
        method: 'bank',
        destination: { masked: '****4821', tag: TAG },
        amount: usdc('210'),
        received: parseMoney('336000', 'NGN'),
        railFee: usdc('1.25'),
        receiptRef: ref('1'),
      },
      {
        index: 1,
        method: 'stellar_wallet',
        destination: { masked: 'GBXQ...7KLM', tag: null },
        amount: usdc('96'),
        received: null,
        railFee: usdc('0'),
        receiptRef: ref('2'),
      },
    ],
  });
}

function storedFor(tenant: Tenant): StoredReceipt {
  const receipt = receiptFor(tenant);
  return { payoutId: PAYOUT_ID, receipt, documentSha256: documentSha256(receipt) };
}

const SAMPLE = generateFixtures({ seed: 7, payouts: 40 }).receipts[0];

function recordFor(tenant: Tenant): PrincipalReceiptRecord {
  if (SAMPLE === undefined) throw new Error('the fixtures have no receipt');
  const deliveredAt = '2026-10-31T09:14:00.000Z';
  return {
    id: RECEIPT_ID,
    supersedesReceiptId: null,
    stored: storedFor(tenant),
    context: {
      verifyUrl: SAMPLE.verifyUrl,
      payerDisplayName: SAMPLE.payerDisplayName,
      deliveredAt,
      recipient: SAMPLE.recipient,
      attempt: SAMPLE.attempt,
      allowedBy: SAMPLE.allowedBy,
      approvals: SAMPLE.approvals,
      timeline: SAMPLE.timeline,
      legs: [
        {
          rail: 'stellar.sep31',
          anchorName: 'Anchor',
          cashOut: null,
          anchorTransactionId: 'anchor-1',
          deliveredAt,
        },
        {
          rail: 'stellar.wallet',
          anchorName: null,
          cashOut: null,
          anchorTransactionId: null,
          deliveredAt,
        },
      ],
    },
  };
}

const isTenant = (a: Tenant, b: Tenant): boolean =>
  a.principalId === b.principalId && a.projectId === b.projectId;

/** Tenant A holds the one receipt. Every read answers only for its own tenant. */
function reads(overrides: Partial<ReceiptReads> = {}): ReceiptReads {
  return {
    principalReceipt: (tenant, id) =>
      Promise.resolve(isTenant(tenant, TENANT_A) && id === RECEIPT_ID ? recordFor(tenant) : null),
    payoutReceipt: (tenant, id) =>
      Promise.resolve(isTenant(tenant, TENANT_A) && id === PAYOUT_ID ? recordFor(tenant) : null),
    exportRows: (tenant) => Promise.resolve(isTenant(tenant, TENANT_A) ? [storedFor(tenant)] : []),
    verify: (req) =>
      Promise.resolve(
        req.receiptNumber === 'R-7K2M9Q4X8B1C' && req.code === CODE
          ? {
              status: 'verified',
              reason: null,
              receipt: {
                view: 'recipient',
                receiptNumber: req.receiptNumber,
                revision: 1,
                supersedes: null,
                issuedAt: '2026-10-31T09:15:00.000Z',
                total: 'KSh 12,900.00',
                summary: 'KSh 12,900.00 paid to mobile money',
                legs: [
                  {
                    method: 'mobile_money',
                    label: 'to mobile money',
                    received: 'KSh 12,900.00',
                    destination: '+254 *** 512',
                  },
                ],
              },
            }
          : null,
      ),
    ...overrides,
  };
}

const authenticate: Authenticate = (credentials) => {
  const token = credentials.authorization?.replace(/^Bearer /, '');
  const tenantOf: Record<string, Tenant | undefined> = {
    a: TENANT_A,
    b: TENANT_B,
    noscope: TENANT_A,
  };
  const tenant = token === undefined ? undefined : tenantOf[token];
  if (tenant === undefined) return Promise.resolve({ ok: false, code: 'TOKEN_MALFORMED' });
  const scopes = token === 'noscope' ? ['recipients:read' as const] : ['receipts:read' as const];
  return Promise.resolve({ ok: true, tenant: { ...tenant, tokenId: TOKEN_ID, scopes } });
};

function served(with_: ReceiptReads = reads()) {
  const logger = memoryLogger();
  const app = createApp({
    routes: v1Routes({
      selfWebhook: SELF_WEBHOOK_NOT_CONFIGURED,
      walletProof: WALLET_PROOF_NOT_CONFIGURED,
      mandates: MANDATES_NOT_CONFIGURED,
      recipients: RECIPIENTS_NOT_CONFIGURED,
      receipts: with_,
    }),
    authenticate,
    rateLimit: allowEveryRequest,
    idempotency: memoryIdempotencyStore(),
    addressRateLimit: allowEveryAddress,
    logger,
  });
  return {
    records: logger.records,
    get: (path: string, token: string | null = 'a') =>
      app.request(path, token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
  };
}

const VERIFY = `/v1/receipt-verifications/R-7K2M9Q4X8B1C?code=${CODE}`;

test('the principal view states the document and the payout', async () => {
  const response = await served().get(`/v1/receipts/${RECEIPT_ID}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({
    view: 'principal',
    id: RECEIPT_ID,
    principalId: TENANT_A.principalId,
    projectId: TENANT_A.projectId,
    payoutId: PAYOUT_ID,
    receiptNumber: 'R-7K2M9Q4X8B1C',
    documentSha256: documentSha256(receiptFor(TENANT_A)),
    takeBps: 50,
    requested: { amount: '48000000', currency: 'NGN', scale: 2 },
    settlement: { amount: '3060000000' },
    take: { amount: '15300000' },
    takeRefunded: { amount: '5000000' },
    charged: { amount: '3075300000' },
  });
  expect(body['legs']).toMatchObject([
    { index: 0, method: 'bank', txHash: '1'.repeat(64), received: { currency: 'NGN' } },
    { index: 1, method: 'stellar_wallet', txHash: '2'.repeat(64), received: null },
  ]);
});

test('a payout reads its latest receipt', async () => {
  const response = await served().get(`/v1/payouts/${PAYOUT_ID}/receipt`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ view: 'principal', payoutId: PAYOUT_ID });
  expect((await served().get(`/v1/payouts/${RECEIPT_ID}/receipt`)).status).toBe(404);
});

test("another principal's receipt is 404", async () => {
  const api = served();
  for (const path of [
    `/v1/receipts/${RECEIPT_ID}`,
    `/v1/payouts/${PAYOUT_ID}/receipt`,
    `/v1/receipts/${RECEIPT_ID}/pdf`,
  ]) {
    const response = await api.get(path, 'b');
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(TENANT_A.principalId);
  }
  const exported = await api.get('/v1/receipt-exports', 'b');
  expect(exported.status).toBe(200);
  expect(await exported.text()).not.toContain(TENANT_A.principalId);
});

test('a store that answers for another tenant never reaches the caller', async () => {
  const leaky = reads({
    principalReceipt: () => Promise.resolve(recordFor(TENANT_A)),
    exportRows: () => Promise.resolve([storedFor(TENANT_A)]),
  });
  const api = served(leaky);
  for (const path of [
    `/v1/receipts/${RECEIPT_ID}`,
    `/v1/receipts/${RECEIPT_ID}/pdf`,
    '/v1/receipt-exports',
  ]) {
    const response = await api.get(path, 'b');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(TENANT_A.principalId);
  }
});

test('every principal route needs a key with receipts:read', async () => {
  const api = served();
  for (const path of [
    `/v1/receipts/${RECEIPT_ID}`,
    `/v1/payouts/${PAYOUT_ID}/receipt`,
    `/v1/receipts/${RECEIPT_ID}/pdf`,
    '/v1/receipt-exports',
  ]) {
    expect((await api.get(path, null)).status).toBe(401);
    expect((await api.get(path, 'noscope')).status).toBe(403);
  }
});

test('an export comes back as a CSV file with the filter applied', async () => {
  const seen: ReceiptExportFilter[] = [];
  const api = served(
    reads({
      exportRows: (tenant, filter) => {
        seen.push(filter);
        return Promise.resolve([storedFor(tenant)]);
      },
    }),
  );
  const response = await api.get(
    `/v1/receipt-exports?payoutId=${PAYOUT_ID}&from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="receipts.csv"');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('request-id')).not.toBeNull();
  const text = await response.text();
  expect(text.startsWith('receipt_number,')).toBe(true);
  expect(text).toContain('R-7K2M9Q4X8B1C');
  expect(seen).toEqual([
    {
      payoutId: PAYOUT_ID,
      from: '2026-10-01T00:00:00Z',
      to: '2026-11-01T00:00:00Z',
      limit: 1000,
    },
  ]);
  await api.get('/v1/receipt-exports');
  expect(seen[1]).toEqual({ limit: 1000 });
});

test('an export refuses a filter it does not know', async () => {
  const api = served();
  for (const query of [
    'nope=1',
    'payoutId=x',
    'from=yesterday',
    'from=2026-10-01T00:00:00Z&from=2026-10-02T00:00:00Z',
  ]) {
    expect((await api.get(`/v1/receipt-exports?${query}`)).status).toBe(400);
  }
});

test('a receipt comes back as a PDF file', async () => {
  const response = await served().get(`/v1/receipts/${RECEIPT_ID}/pdf`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/pdf');
  expect(response.headers.get('content-disposition')).toBe(
    'attachment; filename="R-7K2M9Q4X8B1C.pdf"',
  );
  const bytes = Buffer.from(await response.arrayBuffer()).toString('latin1');
  expect(bytes.startsWith('%PDF-1.4')).toBe(true);
  expect(bytes).toContain('R-7K2M9Q4X8B1C');
});

test('the public check needs no key and answers with the recipient view', async () => {
  const response = await served().get(VERIFY, null);
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(PublicReceiptVerification.safeParse(body).success).toBe(true);
  expect(body).toMatchObject({ status: 'verified', receipt: { view: 'recipient' } });
  const text = JSON.stringify(body);
  for (const hidden of ['principalId', 'projectId', 'mandate', 'tag', TENANT_A.principalId]) {
    expect(text).not.toContain(hidden);
  }
});

test('a wrong code is the same 404 as an unknown number', async () => {
  const api = served();
  const wrong = await api.get(
    '/v1/receipt-verifications/R-7K2M9Q4X8B1C?code=AAAAAAAAAAAAAAAAAAAA',
    null,
  );
  const unknown = await api.get(`/v1/receipt-verifications/R-000000000000?code=${CODE}`, null);
  expect(wrong.status).toBe(404);
  expect(unknown.status).toBe(404);
  const shape = async (response: Response) => {
    const body = (await response.json()) as Record<string, unknown>;
    Reflect.deleteProperty(body, 'requestId');
    return body;
  };
  expect(await shape(wrong)).toEqual(await shape(unknown));
});

test('the public check refuses a malformed request before it reads anything', async () => {
  const verify = () => Promise.reject(new Error('must not be called'));
  const api = served(reads({ verify }));
  expect((await api.get('/v1/receipt-verifications/R-7K2M9Q4X8B1C', null)).status).toBe(400);
  expect((await api.get('/v1/receipt-verifications/R-7K2M9Q4X8B1C?code=short', null)).status).toBe(
    400,
  );
  expect((await api.get(`${VERIFY}&locale=not%20a%20locale`, null)).status).toBe(400);
  expect((await api.get(`/v1/receipt-verifications/nope?code=${CODE}`, null)).status).toBe(404);
});

test('the public check passes the locale on, and logs neither the code nor the number', async () => {
  const locales: string[] = [];
  const base = reads();
  const api = served(
    reads({
      verify: (req, opts) => {
        locales.push(req.locale);
        return base.verify(req, opts);
      },
    }),
  );
  await api.get(VERIFY, null);
  await api.get(`${VERIFY}&locale=de-DE`, null);
  expect(locales).toEqual(['en-US', 'de-DE']);
  const log = JSON.stringify(api.records);
  expect(log).not.toContain(CODE);
  expect(log).not.toContain('R-7K2M9Q4X8B1C');
});

test('a leg the payout does not know about is a 500, not a guess', async () => {
  const record = recordFor(TENANT_A);
  const short: PrincipalReceiptRecord = {
    ...record,
    context: { ...record.context, legs: record.context.legs.slice(0, 1) },
  };
  const api = served(reads({ principalReceipt: () => Promise.resolve(short) }));
  expect((await api.get(`/v1/receipts/${RECEIPT_ID}`)).status).toBe(500);
  expect(() => toPrincipalReceipt(short)).toThrow();
});

test('the served routes answer 503 until the tables are in, and are documented', async () => {
  const app = createApp({
    routes: V1_ROUTES,
    authenticate,
    rateLimit: allowEveryRequest,
    idempotency: memoryIdempotencyStore(),
    addressRateLimit: allowEveryAddress,
    logger: memoryLogger(),
  });
  const headers = { authorization: 'Bearer a' };
  for (const path of [
    `/v1/receipts/${RECEIPT_ID}`,
    `/v1/payouts/${PAYOUT_ID}/receipt`,
    `/v1/receipts/${RECEIPT_ID}/pdf`,
    '/v1/receipt-exports',
  ]) {
    expect((await app.request(path, { headers })).status).toBe(503);
  }
  expect((await app.request(VERIFY)).status).toBe(503);

  const paths = buildOpenApiDocument(V1_ROUTES)['paths'] as Record<string, Record<string, unknown>>;
  const csv = paths['/v1/receipt-exports']?.['get'] as { responses: Record<string, unknown> };
  expect(csv.responses['200']).toMatchObject({
    content: { 'text/csv; charset=utf-8': { schema: { type: 'string', format: 'binary' } } },
  });
  expect(paths['/v1/receipt-verifications/{receiptNumber}']).toBeDefined();
});
