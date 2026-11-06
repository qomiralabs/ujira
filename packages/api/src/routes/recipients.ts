// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The recipient endpoints. A write or a list shows nothing personal; only the read
// of one recipient does, under its own scope.

import {
  CreateRecipientRequest,
  RecipientDetail,
  RecipientListQuery,
  RecipientPage,
  RecipientParams,
  RecipientPayoutMethod,
  RecipientSummaryView,
} from '@ujira/api-schema';
import { z } from 'zod';

import { RecipientDestinationBody } from '../destination.js';
import { ApiError } from '../errors.js';
import { defineTenantRoute } from '../route.js';
import type { Route, TenantRequestContext } from '../route.js';

/** Details such as a bank account. Encrypted before anything stores them, and never sent back. */
const MethodDetails = z.record(z.string().min(1).max(64), z.string().max(500));

export const CreateMethodRequest = z.strictObject({
  method: z.enum(['stellar_wallet', 'bank', 'mobile_money', 'cash_pickup']),
  destination: RecipientDestinationBody,
  details: MethodDetails.optional(),
});

export interface RecipientEndpoints {
  readonly create: (
    body: z.output<typeof CreateRecipientRequest>,
    context: TenantRequestContext,
  ) => Promise<z.input<typeof RecipientSummaryView>>;
  readonly get: (
    id: string,
    context: TenantRequestContext,
  ) => Promise<z.input<typeof RecipientDetail>>;
  readonly list: (
    query: z.output<typeof RecipientListQuery>,
    context: TenantRequestContext,
  ) => Promise<z.input<typeof RecipientPage>>;
  readonly addMethod: (
    id: string,
    body: z.output<typeof CreateMethodRequest>,
    context: TenantRequestContext,
  ) => Promise<z.input<typeof RecipientPayoutMethod>>;
}

const notConfigured = (): Promise<never> => Promise.reject(new ApiError('DB_UNAVAILABLE'));

/** Stands in until personal data has its data keys, so nothing is ever stored unencrypted. */
export const RECIPIENTS_NOT_CONFIGURED: RecipientEndpoints = Object.freeze({
  create: notConfigured,
  get: notConfigured,
  list: notConfigured,
  addMethod: notConfigured,
});

export function recipientRoutes(flow: RecipientEndpoints): readonly Route[] {
  return [
    defineTenantRoute({
      id: 'createRecipient',
      method: 'POST',
      path: '/v1/recipients',
      summary: 'Register a recipient. What is personal is encrypted, and not sent back',
      scope: 'recipients:write',
      body: CreateRecipientRequest,
      response: { status: 201, name: 'RecipientSummaryView', schema: RecipientSummaryView },
      handler: ({ body }, context) => flow.create(body, context),
    }),
    defineTenantRoute({
      id: 'listRecipients',
      method: 'GET',
      path: '/v1/recipients',
      summary: 'List recipients, with nothing personal in the list',
      scope: 'recipients:read',
      query: RecipientListQuery,
      response: { name: 'RecipientPage', schema: RecipientPage },
      handler: ({ query }, context) => flow.list(query, context),
    }),
    defineTenantRoute({
      id: 'getRecipient',
      method: 'GET',
      path: '/v1/recipients/{id}',
      summary: 'One recipient, with their personal data and how they are paid',
      scope: 'recipients:read',
      params: RecipientParams,
      response: { name: 'RecipientDetail', schema: RecipientDetail },
      errors: ['NOT_FOUND'],
      handler: ({ params }, context) => flow.get(params.id, context),
    }),
    defineTenantRoute({
      id: 'createRecipientMethod',
      method: 'POST',
      path: '/v1/recipients/{id}/methods',
      summary: 'Add a payout method, once its destination has been validated',
      scope: 'recipients:write',
      params: RecipientParams,
      body: CreateMethodRequest,
      response: { status: 201, name: 'RecipientPayoutMethod', schema: RecipientPayoutMethod },
      errors: ['NOT_FOUND', 'DESTINATION_INVALID'],
      handler: ({ params, body }, context) => flow.addMethod(params.id, body, context),
    }),
  ];
}
