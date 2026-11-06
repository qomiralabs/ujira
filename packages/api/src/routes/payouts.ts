// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The payout endpoints. A create answers 202 as soon as the payout and its job
// are written, and says nothing personal, since its answer is stored for replay.
// The reads are the published contract's listPayouts and getPayout.

import { CreatePayoutRequest, PayoutAccepted } from '@ujira/api-schema';
import type { PayoutDetail, PayoutListQuery, PayoutPage } from '@ujira/api-schema';
import type { z } from 'zod';

import { ApiError } from '../errors.js';
import { contractRoute, defineTenantRoute } from '../route.js';
import type { Route, TenantRequestContext } from '../route.js';

export type PayoutPageBody = z.infer<typeof PayoutPage>;

export interface PayoutEndpoints {
  readonly create: (
    body: CreatePayoutRequest,
    context: TenantRequestContext,
  ) => Promise<PayoutAccepted>;
  readonly list: (query: PayoutListQuery, context: TenantRequestContext) => Promise<PayoutPageBody>;
  readonly get: (id: string, context: TenantRequestContext) => Promise<PayoutDetail>;
}

const notConfigured = (): Promise<never> => Promise.reject(new ApiError('DB_UNAVAILABLE'));

/** Stands in until the worker's queue is in, so no payout is taken that nothing would run. */
export const PAYOUTS_NOT_CONFIGURED: PayoutEndpoints = Object.freeze({
  create: notConfigured,
  list: notConfigured,
  get: notConfigured,
});

export function payoutRoutes(flow: PayoutEndpoints): readonly Route[] {
  return [
    defineTenantRoute({
      id: 'createPayout',
      method: 'POST',
      path: '/v1/payouts',
      summary:
        'Pay a recipient inside a mandate. Answers at once; the payout runs in the background',
      scope: 'payouts:write',
      rateLimit: 'payout_creation',
      body: CreatePayoutRequest,
      response: { status: 202, name: 'PayoutAccepted', schema: PayoutAccepted },
      errors: [
        'NOT_FOUND',
        'INVALID_AMOUNT',
        'DESTINATION_INVALID',
        'MANDATE_REFUSED',
        'QUOTE_UNAVAILABLE',
      ],
      handler: ({ body }, context) => flow.create(body, context),
    }),
    contractRoute('listPayouts', {
      scope: 'payouts:read',
      handler: ({ query }, context) => flow.list(query, context),
    }),
    contractRoute('getPayout', {
      scope: 'payouts:read',
      handler: ({ params }, context) => flow.get(params.id, context),
    }),
  ];
}
