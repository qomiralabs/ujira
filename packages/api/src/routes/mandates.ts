// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mandate endpoints. A principal's own wallet signs everything that changes a
// mandate, so each write here hands back signing requests and moves nothing itself.

import {
  CreateMandateRequest,
  LowerFeeCapRequest,
  MandateActionPrepared,
  MandateCreated,
  MandateFunding,
  MandateParams,
} from '@ujira/api-schema';
import type { MandateDetail, ProblemCode } from '@ujira/api-schema';
import type { z } from 'zod';

import { ApiError } from '../errors.js';
import { contractRoute, defineTenantRoute } from '../route.js';
import type { Route, TenantRequestContext } from '../route.js';

type Created = z.input<typeof MandateCreated>;
type Prepared = z.input<typeof MandateActionPrepared>;
type Funding = z.input<typeof MandateFunding>;

export interface MandateEndpoints {
  readonly create: (
    body: z.output<typeof CreateMandateRequest>,
    context: TenantRequestContext,
  ) => Promise<Created>;
  readonly get: (id: string, context: TenantRequestContext) => Promise<MandateDetail>;
  readonly funding: (id: string, context: TenantRequestContext) => Promise<Funding>;
  readonly lowerFeeCap: (
    id: string,
    body: z.output<typeof LowerFeeCapRequest>,
    context: TenantRequestContext,
  ) => Promise<Prepared>;
  readonly revoke: (id: string, context: TenantRequestContext) => Promise<Prepared>;
  readonly withdraw: (id: string, context: TenantRequestContext) => Promise<Prepared>;
  readonly cancelPrincipalProposal: (
    id: string,
    context: TenantRequestContext,
  ) => Promise<Prepared>;
}

/**
 * Stands in until an assembled chain adapter and the production stores exist.
 * Nothing can be prepared, and a client can try again later.
 */
const notConfigured = (): Promise<never> => Promise.reject(new ApiError('CHAIN_UNAVAILABLE'));

export const MANDATES_NOT_CONFIGURED: MandateEndpoints = Object.freeze({
  create: notConfigured,
  get: notConfigured,
  funding: notConfigured,
  lowerFeeCap: notConfigured,
  revoke: notConfigured,
  withdraw: notConfigured,
  cancelPrincipalProposal: notConfigured,
});

const ACTION_ERRORS: readonly ProblemCode[] = ['NOT_FOUND', 'MANDATE_REFUSED', 'CHAIN_UNAVAILABLE'];

function actionRoute(
  id: string,
  segment: string,
  summary: string,
  run: (mandateId: string, context: TenantRequestContext) => Promise<Prepared>,
  errors: readonly ProblemCode[] = ACTION_ERRORS,
): Route {
  return defineTenantRoute({
    id,
    method: 'POST',
    path: `/v1/mandates/{id}/${segment}`,
    summary,
    scope: 'mandates:write',
    params: MandateParams,
    response: { name: 'MandateActionPrepared', schema: MandateActionPrepared },
    errors,
    handler: ({ params }, context) => run(params.id, context),
  });
}

export function mandateRoutes(flow: MandateEndpoints): readonly Route[] {
  return [
    defineTenantRoute({
      id: 'createMandate',
      method: 'POST',
      path: '/v1/mandates',
      summary: 'Create a mandate, returning what its principal must sign on each chain',
      scope: 'mandates:write',
      body: CreateMandateRequest,
      response: { status: 201, name: 'MandateCreated', schema: MandateCreated },
      errors: [
        'FEE_CAP_INVALID',
        'PRINCIPAL_KEY_RISK',
        'CUSTODY_GUARD',
        'OPERATIONS_GUARDIAN_NOT_CONFIGURED',
        'CHAIN_UNAVAILABLE',
      ],
      handler: ({ body }, context) => flow.create(body, context),
    }),
    contractRoute('getMandate', {
      scope: 'mandates:read',
      handler: ({ params }, context) => flow.get(params.id, context),
    }),
    defineTenantRoute({
      id: 'getMandateFunding',
      method: 'GET',
      path: '/v1/mandates/{id}/funding',
      summary: 'How to fund a mandate, on each chain it has an instance',
      scope: 'mandates:read',
      params: MandateParams,
      response: { name: 'MandateFunding', schema: MandateFunding },
      errors: ['NOT_FOUND', 'CHAIN_UNAVAILABLE'],
      handler: ({ params }, context) => flow.funding(params.id, context),
    }),
    defineTenantRoute({
      id: 'lowerMandateFeeCap',
      method: 'POST',
      path: '/v1/mandates/{id}/lower-fee-cap',
      summary: 'Prepare a lower fee cap for the principal to sign',
      scope: 'mandates:write',
      params: MandateParams,
      body: LowerFeeCapRequest,
      response: { name: 'MandateActionPrepared', schema: MandateActionPrepared },
      errors: [...ACTION_ERRORS, 'FEE_CAP_INVALID'],
      handler: ({ params, body }, context) => flow.lowerFeeCap(params.id, body, context),
    }),
    actionRoute(
      'revokeMandate',
      'revoke',
      'Prepare a revoke for the principal to sign, and say what to withdraw after it',
      flow.revoke,
    ),
    actionRoute(
      'withdrawMandate',
      'withdraw',
      'Prepare a withdrawal of the whole balance for the principal to sign',
      flow.withdraw,
      [...ACTION_ERRORS, 'TRANSFER_FAILED'],
    ),
    actionRoute(
      'cancelMandatePrincipalProposal',
      'cancel-principal-proposal',
      'Prepare the cancelling of a pending principal change for the principal to sign',
      flow.cancelPrincipalProposal,
    ),
  ];
}
