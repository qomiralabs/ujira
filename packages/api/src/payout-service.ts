// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the payout endpoints do. A create writes the payout and the worker's job
// in one transaction and answers at once; the payout moves on in the worker. The
// payout carries the client's Idempotency-Key under a unique constraint of its
// own, so a handler run again after its process died finds the first payout and
// pays nothing twice.

import { PAGE_LIMIT_DEFAULT, fromWireMoney } from '@ujira/api-schema';
import type {
  CreatePayoutRequest,
  PayoutAccepted,
  PayoutDetail,
  PayoutListQuery,
} from '@ujira/api-schema';
import { SETTLEMENT_TOKENS, money, usdToToken } from '@ujira/core';
import type { FiatCurrencyCode, Money } from '@ujira/core';
import {
  AmountBelowMinimumError,
  IdempotencyConflictError,
  MAX_PAGE_SIZE,
  MinimumNotComparableError,
  RequestedAmountModeError,
} from '@ujira/db';
import type {
  Payout,
  PayoutAmountBound,
  PayoutListFilter,
  PayoutListPage,
  PayoutPosition,
  PayoutView,
} from '@ujira/db';
import { z } from 'zod';

import type { Tenant } from './auth.js';
import { cursorCodec } from './cursor.js';
import { ApiError } from './errors.js';
import { toPayoutAccepted, toPayoutDetail, toPayoutListItem } from './payout-wire.js';
import type { PayoutReceiptLink } from './payout-wire.js';
import type { PayoutEndpoints, PayoutPageBody } from './routes/payouts.js';
import type { TenantRequestContext } from './route.js';

export type PayoutMethodValue = NonNullable<CreatePayoutRequest['method']>;

export interface NewPayoutRequest {
  readonly idempotencyKey: string;
  readonly mandateId: string;
  readonly recipientId: string;
  /** What the principal asked to pay, as the client sent it. */
  readonly amount: Money;
  /** Null to take the recipient's first active method. */
  readonly method: PayoutMethodValue | null;
  readonly taskId: string | null;
}

/** What a create came to. Each refusal is decided before anything is written. */
export type PayoutCreation =
  | { readonly outcome: 'created' | 'existing'; readonly payout: Payout }
  | {
      readonly outcome:
        | 'recipient_not_found'
        | 'mandate_not_found'
        | 'recipient_inactive'
        | 'no_method'
        | 'mandate_not_deployed'
        | 'amount_unit';
    };

/** What the payout endpoints read and write through. Every call takes the tenant. */
export interface PayoutRecords {
  /**
   * Writes the payout and schedules its job in one transaction, or finds the one
   * the key already made. A key reused for another payout is IdempotencyConflictError.
   */
  readonly create: (tenant: Tenant, request: NewPayoutRequest) => Promise<PayoutCreation>;
  readonly page: (
    tenant: Tenant,
    filter: PayoutListFilter,
    page: { readonly limit: number; readonly after?: PayoutPosition },
  ) => Promise<PayoutListPage>;
  readonly get: (tenant: Tenant, id: string) => Promise<PayoutView | undefined>;
}

/** The names to show for recipients, decrypted where they were given one. */
export type RecipientNames = (
  tenant: Tenant,
  recipientIds: readonly string[],
  signal: AbortSignal,
) => Promise<ReadonlyMap<string, string>>;

/** The receipt of a paid payout. */
export type PayoutReceiptLinks = (
  tenant: Tenant,
  payoutId: string,
) => Promise<PayoutReceiptLink | null>;

export interface PayoutServiceDeps {
  readonly records: PayoutRecords;
  readonly names: RecipientNames;
  readonly receipts: PayoutReceiptLinks;
  /** Signs list cursors. At least 32 bytes, the same on every instance. */
  readonly cursorKey: Uint8Array;
}

const Position = z.strictObject({
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  id: z.uuid(),
});

const AMOUNT_DETAIL =
  'This project asks for payouts in US dollars, paid as USDC, or in the local currency its recipients receive. Check the project setting and the amount.';
const MINIMUM_DETAIL = 'The amount is below the minimum for this payout method.';
const METHOD_DETAIL = 'This recipient has no active payout method of that kind.';
const MANDATE_DETAIL = 'This mandate is not deployed on any network yet.';

function refusal(creation: Exclude<PayoutCreation, { readonly payout: Payout }>): ApiError {
  switch (creation.outcome) {
    // Another tenant's recipient or mandate reads exactly like one that never existed.
    case 'recipient_not_found':
    case 'mandate_not_found':
      return new ApiError('NOT_FOUND');
    case 'recipient_inactive':
    case 'no_method':
      return new ApiError('DESTINATION_INVALID', { detail: METHOD_DETAIL });
    case 'mandate_not_deployed':
      return new ApiError('MANDATE_REFUSED', { detail: MANDATE_DETAIL });
    case 'amount_unit':
      return new ApiError('INVALID_AMOUNT', { detail: AMOUNT_DETAIL });
  }
}

// The store's own refusals, each made before it wrote anything.
function storeRefusal(error: unknown): ApiError | null {
  if (error instanceof IdempotencyConflictError) return new ApiError('IDEMPOTENCY_KEY_REUSED');
  if (error instanceof RequestedAmountModeError) {
    return new ApiError('INVALID_AMOUNT', { detail: AMOUNT_DETAIL });
  }
  if (error instanceof AmountBelowMinimumError) {
    return new ApiError('INVALID_AMOUNT', { detail: MINIMUM_DETAIL });
  }
  // A minimum in another currency needs a rate to compare with, and none is quoted yet.
  if (error instanceof MinimumNotComparableError) return new ApiError('QUOTE_UNAVAILABLE');
  return null;
}

// The units a requested amount in this currency can be held in: the currency
// itself, and for US dollars each dollar token at par.
function amountBounds(currency: FiatCurrencyCode, min?: bigint, max?: bigint): PayoutAmountBound[] {
  const fiat: PayoutAmountBound = {
    kind: 'fiat',
    currency,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
  if (currency !== 'USD') return [fiat];
  const tokens = SETTLEMENT_TOKENS.map((token): PayoutAmountBound => {
    const at = (cents: bigint): bigint =>
      usdToToken(money(cents, 'USD'), token.asset, token.chain).amount;
    return {
      kind: 'token',
      asset: token.asset,
      chain: token.chain,
      ...(min === undefined ? {} : { min: at(min) }),
      ...(max === undefined ? {} : { max: at(max) }),
    };
  });
  return [fiat, ...tokens];
}

function filterOf(query: PayoutListQuery): PayoutListFilter {
  const amounts =
    query.amountCurrency === undefined
      ? undefined
      : amountBounds(
          query.amountCurrency,
          query.amountMin === undefined ? undefined : BigInt(query.amountMin),
          query.amountMax === undefined ? undefined : BigInt(query.amountMax),
        );
  return {
    ...(query.status === undefined ? {} : { statuses: query.status }),
    ...(query.corridor === undefined ? {} : { corridors: query.corridor }),
    ...(query.method === undefined ? {} : { methods: query.method }),
    ...(query.mandateId === undefined ? {} : { mandateIds: query.mandateId }),
    ...(query.network === undefined ? {} : { networks: query.network }),
    ...(amounts === undefined ? {} : { amounts }),
    ...(query.createdFrom === undefined ? {} : { createdFrom: new Date(query.createdFrom) }),
    ...(query.createdTo === undefined ? {} : { createdTo: new Date(query.createdTo) }),
  };
}

export function createPayoutEndpoints(deps: PayoutServiceDeps): PayoutEndpoints {
  const { records } = deps;
  const cursors = cursorCodec(deps.cursorKey);

  const nameOf = (names: ReadonlyMap<string, string>, id: string): string => {
    const name = names.get(id);
    // The port answers for every id it is asked about.
    if (name === undefined) throw new ApiError('INTERNAL');
    return name;
  };

  return {
    create: async (body, context: TenantRequestContext): Promise<PayoutAccepted> => {
      const { tenant, idempotencyKey } = context;
      // The pipeline refuses a write without one before it gets here.
      if (idempotencyKey === null) throw new ApiError('INTERNAL');
      let creation: PayoutCreation;
      try {
        creation = await records.create(tenant, {
          idempotencyKey,
          mandateId: body.mandateId,
          recipientId: body.recipientId,
          amount: fromWireMoney(body.amount),
          method: body.method ?? null,
          taskId: body.taskId ?? null,
        });
      } catch (error) {
        throw storeRefusal(error) ?? error;
      }
      if (!('payout' in creation)) throw refusal(creation);
      return toPayoutAccepted(tenant, creation.payout);
    },

    list: async (query, context): Promise<PayoutPageBody> => {
      const { tenant } = context;
      const { limit, cursor, ...filters } = query;
      const binding = { tenant, route: 'listPayouts', query: filters };
      let after: PayoutPosition | undefined;
      if (cursor !== undefined) {
        const position = Position.safeParse(cursors.decode(binding, cursor));
        if (!position.success) throw new ApiError('INVALID_CURSOR');
        after = position.data;
      }
      const page = await records.page(tenant, filterOf(query), {
        // The wire allows what any list allows; a page here stops at what the table serves.
        limit: Math.min(limit ?? PAGE_LIMIT_DEFAULT, MAX_PAGE_SIZE),
        ...(after === undefined ? {} : { after }),
      });
      const names = await deps.names(
        tenant,
        [...new Set(page.items.map((item) => item.payout.recipientId))],
        context.signal,
      );
      return {
        items: page.items.map((item) =>
          toPayoutListItem(tenant, item, nameOf(names, item.payout.recipientId)),
        ),
        nextCursor: page.next === null ? null : cursors.encode(binding, page.next),
      };
    },

    get: async (id, context): Promise<PayoutDetail> => {
      const { tenant } = context;
      const found = await records.get(tenant, id);
      // Another tenant's payout reads exactly like one that never existed.
      if (found === undefined) throw new ApiError('NOT_FOUND');
      const names = await deps.names(tenant, [found.payout.recipientId], context.signal);
      const receipt =
        found.payout.publicStatus === 'paid' ? await deps.receipts(tenant, found.payout.id) : null;
      return toPayoutDetail(tenant, found, nameOf(names, found.payout.recipientId), receipt);
    },
  };
}
