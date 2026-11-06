// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The payout endpoints through the whole pipeline, over a store held in memory.
// Tests only: this file is left out of the build. The store keeps the promises
// the database one does: one payout per key, its job scheduled exactly when it
// is first written, and a page ending at a position that the next starts after.

import { randomBytes, randomUUID } from 'node:crypto';

import { Problem } from '@ujira/api-schema';
import { money, tokenAmount } from '@ujira/core';
import type { Money, TokenAmount } from '@ujira/core';
import { IdempotencyConflictError } from '@ujira/db';
import type { Payout, PayoutLeg, PayoutListing, PayoutPosition, PayoutView } from '@ujira/db';

import { createApp } from './app.js';
import type { Authenticate, Tenant } from './auth.js';
import { memoryIdempotencyStore } from './idempotency.js';
import type { IdempotencyStore } from './idempotency.js';
import { memoryLogger } from './log.js';
import { createPayoutEndpoints } from './payout-service.js';
import type {
  NewPayoutRequest,
  PayoutCreation,
  PayoutReceiptLinks,
  PayoutRecords,
  RecipientNames,
} from './payout-service.js';
import { allowEveryRequest } from './rate-limit.js';
import { payoutRoutes } from './routes/payouts.js';
import type { PayoutEndpoints } from './routes/payouts.js';

export const TENANT_A: Tenant = { principalId: randomUUID(), projectId: randomUUID() };
export const TENANT_B: Tenant = { principalId: randomUUID(), projectId: randomUUID() };

export const NETWORK = 'stellar:testnet';
export const ONE_USDC = 10_000_000n;

const tenantKey = (tenant: Tenant): string => `${tenant.principalId}:${tenant.projectId}`;

export function usdc(amount: bigint): TokenAmount {
  return tokenAmount(amount, 'USDC', 'stellar');
}

/** A payout as the table holds it, with what a test does not care about filled in. */
export function storedPayout(overrides: Partial<Payout> = {}): Payout {
  const createdAt = overrides.createdAt ?? new Date('2026-11-01T10:00:00.000Z');
  return {
    id: randomUUID(),
    batchId: null,
    recipientId: randomUUID(),
    mandateId: randomUUID(),
    method: 'stellar_wallet',
    cashoutCostBearer: 'recipient',
    requested: usdc(5n * ONE_USDC),
    total: null,
    status: 'received',
    publicStatus: 'queued',
    statusReason: null,
    taskId: null,
    blockedBy: null,
    allowedBy: null,
    approvedAt: null,
    settledAt: null,
    deliveredAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

export function leg(overrides: Partial<PayoutLeg> = {}): PayoutLeg {
  return {
    id: randomUUID(),
    payoutId: randomUUID(),
    attemptId: randomUUID(),
    index: 0,
    payoutMethodId: randomUUID(),
    method: 'stellar_wallet',
    destinationAddress: 'GA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQHES5',
    destinationTag: null,
    amount: usdc(5n * ONE_USDC),
    fee: usdc(0n),
    legKey: randomBytes(16).toString('hex'),
    chainTxHash: null,
    status: 'planned',
    ...overrides,
  };
}

/** A payout with its context, as the read store hands it over. */
export function view(payout: Payout, extra: Partial<PayoutView> = {}): PayoutView {
  return {
    payout,
    position: { createdAt: payout.createdAt.toISOString().replace('Z', '000Z'), id: payout.id },
    recipientCountry: 'NG',
    mandateName: 'Payroll',
    attempt: null,
    legs: [],
    agreedFeeBps: 50,
    approvalsGiven: 0,
    ...extra,
  };
}

function before(a: PayoutPosition, b: PayoutPosition): boolean {
  return a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
}

/** What a recipient the store knows looks like to a create. */
export interface KnownRecipient {
  readonly id: string;
  readonly active: boolean;
  /** Active methods, first one first. */
  readonly methods: readonly string[];
}

export interface MemoryPayouts extends PayoutRecords {
  /** One entry per job scheduled, as the transaction would have written it. */
  readonly scheduled: { readonly tenant: Tenant; readonly payoutId: string }[];
  readonly views: Map<string, { readonly tenant: string; view: PayoutView }>;
  readonly recipients: Map<string, KnownRecipient>;
  readonly mandates: Set<string>;
  readonly put: (tenant: Tenant, view: PayoutView) => void;
}

/**
 * What the memory store does with a request whose key it already holds: the
 * same answer for the same request, a conflict for another. The database store
 * compares the same fields.
 */
function sameRequest(payout: Payout, request: NewPayoutRequest): boolean {
  const asked: Money = request.amount;
  const held = payout.requested;
  const amountMatches =
    held.kind === 'fiat'
      ? held.currency === asked.currency && held.amount === asked.amount
      : asked.currency === 'USD' && held.amount === asked.amount * 10n ** 5n;
  return (
    payout.mandateId === request.mandateId &&
    payout.recipientId === request.recipientId &&
    payout.taskId === request.taskId &&
    (request.method === null || payout.method === request.method) &&
    amountMatches
  );
}

export function memoryPayouts(): MemoryPayouts {
  const scheduled: { tenant: Tenant; payoutId: string }[] = [];
  const views = new Map<string, { tenant: string; view: PayoutView }>();
  const byKey = new Map<string, string>();
  const recipients = new Map<string, KnownRecipient>();
  const mandates = new Set<string>();
  let clock = Date.parse('2026-11-01T10:00:00.000Z');

  const create = (tenant: Tenant, request: NewPayoutRequest): Promise<PayoutCreation> => {
    const key = `${tenantKey(tenant)}:${request.idempotencyKey}`;
    const held = byKey.get(key);
    if (held !== undefined) {
      const found = views.get(held);
      if (found === undefined) throw new Error('a key points at no payout');
      if (!sameRequest(found.view.payout, request)) {
        return Promise.reject(new IdempotencyConflictError());
      }
      return Promise.resolve({ outcome: 'existing', payout: found.view.payout });
    }
    const recipient = recipients.get(`${tenantKey(tenant)}:${request.recipientId}`);
    if (recipient === undefined) return Promise.resolve({ outcome: 'recipient_not_found' });
    if (!mandates.has(`${tenantKey(tenant)}:${request.mandateId}`)) {
      return Promise.resolve({ outcome: 'mandate_not_found' });
    }
    if (!recipient.active) return Promise.resolve({ outcome: 'recipient_inactive' });
    const method = request.method ?? recipient.methods[0];
    if (method === undefined || !recipient.methods.includes(method)) {
      return Promise.resolve({ outcome: 'no_method' });
    }
    if (request.amount.currency !== 'USD') return Promise.resolve({ outcome: 'amount_unit' });
    clock += 1_000;
    const payout = storedPayout({
      recipientId: request.recipientId,
      mandateId: request.mandateId,
      method,
      requested: usdc(request.amount.amount * 10n ** 5n),
      taskId: request.taskId,
      createdAt: new Date(clock),
    });
    views.set(payout.id, { tenant: tenantKey(tenant), view: view(payout) });
    byKey.set(key, payout.id);
    scheduled.push({ tenant, payoutId: payout.id });
    return Promise.resolve({ outcome: 'created', payout });
  };

  return {
    scheduled,
    views,
    recipients,
    mandates,
    put: (tenant, value) => views.set(value.payout.id, { tenant: tenantKey(tenant), view: value }),
    create,
    page: (tenant, filter, page) => {
      const own = [...views.values()]
        .filter((entry) => entry.tenant === tenantKey(tenant))
        .map((entry) => entry.view)
        .filter(
          (entry) =>
            filter.statuses === undefined || filter.statuses.includes(entry.payout.publicStatus),
        )
        .sort((a, b) => (before(a.position, b.position) ? 1 : -1));
      const after = page.after;
      const rest = after === undefined ? own : own.filter((entry) => before(entry.position, after));
      const items: PayoutListing[] = rest.slice(0, page.limit);
      const last = items.at(-1);
      return Promise.resolve({
        items,
        next: rest.length > page.limit && last !== undefined ? last.position : null,
      });
    },
    get: (tenant, id) => {
      const entry = views.get(id);
      return Promise.resolve(entry?.tenant === tenantKey(tenant) ? entry.view : undefined);
    },
  };
}

/** A name for every recipient asked about, as the decrypted record would give. */
export const NAMES: RecipientNames = (_tenant, ids) =>
  Promise.resolve(new Map(ids.map((id) => [id, `Recipient ${id.slice(0, 4)}`])));

export const NO_RECEIPTS: PayoutReceiptLinks = () => Promise.resolve(null);

export function payoutWorld(
  options: {
    readonly records?: PayoutRecords;
    readonly receipts?: PayoutReceiptLinks;
    readonly idempotency?: IdempotencyStore;
    /** Who the alpha key belongs to, for a test with tenants of its own. */
    readonly as?: Tenant;
    /** In place of the endpoints built over the records. */
    readonly endpoints?: PayoutEndpoints;
  } = {},
) {
  const records = options.records ?? memoryPayouts();
  const logger = memoryLogger();
  const alpha = options.as ?? TENANT_A;
  const authenticate: Authenticate = (credentials) => {
    const token = credentials.authorization?.replace(/^Bearer /, '');
    const tenant = token === 'alpha' ? alpha : token === 'bravo' ? TENANT_B : null;
    if (tenant === null) return Promise.resolve({ ok: false, code: 'TOKEN_INVALID' });
    return Promise.resolve({
      ok: true,
      tenant: { ...tenant, tokenId: randomUUID(), scopes: ['payouts:read', 'payouts:write'] },
    });
  };
  const app = createApp({
    routes: payoutRoutes(
      options.endpoints ??
        createPayoutEndpoints({
          records,
          names: NAMES,
          receipts: options.receipts ?? NO_RECEIPTS,
          cursorKey: randomBytes(32),
        }),
    ),
    authenticate,
    rateLimit: allowEveryRequest,
    idempotency: options.idempotency ?? memoryIdempotencyStore(),
    logger,
  });
  const request = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        authorization: 'Bearer alpha',
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, logger, records, request };
}

export async function problemOf(response: Response): Promise<Problem> {
  return Problem.parse(await response.json());
}

/** A recipient and a mandate the memory store knows, for the tenant given. */
export function knownParties(
  store: MemoryPayouts,
  tenant: Tenant = TENANT_A,
  recipient: Partial<KnownRecipient> = {},
): { readonly recipientId: string; readonly mandateId: string } {
  const recipientId = recipient.id ?? randomUUID();
  const mandateId = randomUUID();
  store.recipients.set(`${tenantKey(tenant)}:${recipientId}`, {
    id: recipientId,
    active: true,
    methods: ['stellar_wallet'],
    ...recipient,
  });
  store.mandates.add(`${tenantKey(tenant)}:${mandateId}`);
  return { recipientId, mandateId };
}

export const TEN_DOLLARS = { amount: '1000', currency: 'USD', scale: 2 } as const;

export function usd(cents: bigint): Money {
  return money(cents, 'USD');
}
