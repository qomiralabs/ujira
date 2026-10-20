// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every read route in v1, with its path, inputs and response. The OpenAPI
// document, the mocks and the contract checks all read this one table, so
// none of them can describe a route differently from the others.

import { z } from 'zod';

import { ApprovalItem, ApprovalListQuery } from './approvals.js';
import { Page } from './envelope.js';
import { FundingOverview, FundingQuery } from './funding.js';
import { MandateDetail, MandateListItem, MandateListQuery, MandateParams } from './mandates.js';
import { PayoutDetail, PayoutListItem, PayoutListQuery, PayoutParams } from './payouts.js';
import { ReceiptListItem, ReceiptListQuery, ReceiptParams, ReceiptView } from './receipts.js';
import { OverviewStats, OverviewStatsQuery } from './stats.js';

export const MandatePage = Page(MandateListItem);
export const PayoutPage = Page(PayoutListItem);
export const ReceiptPage = Page(ReceiptListItem);
export const ApprovalPage = Page(ApprovalItem);

const NoParams = z.strictObject({});

// Statuses each kind of route can answer with besides 200.
const LIST_ERRORS = [400, 401, 403, 429] as const;
const DETAIL_ERRORS = [400, 401, 403, 404, 429] as const;

export interface RouteDefinition {
  readonly method: 'GET';
  /** OpenAPI style, with {name} for path parameters. */
  readonly path: string;
  readonly summary: string;
  readonly params: z.ZodObject;
  readonly query: z.ZodType;
  readonly response: z.ZodType;
  readonly errors: readonly number[];
}

export const ROUTES = {
  listMandates: {
    method: 'GET',
    path: '/v1/mandates',
    summary: 'List mandates, newest first',
    params: NoParams,
    query: MandateListQuery,
    response: MandatePage,
    errors: LIST_ERRORS,
  },
  getMandate: {
    method: 'GET',
    path: '/v1/mandates/{id}',
    summary: 'One mandate with its limits, usage, roles, country policy and instances',
    params: MandateParams,
    query: NoParams,
    response: MandateDetail,
    errors: DETAIL_ERRORS,
  },
  listPayouts: {
    method: 'GET',
    path: '/v1/payouts',
    summary: 'List payouts, newest first, filtered',
    params: NoParams,
    query: PayoutListQuery,
    response: PayoutPage,
    errors: LIST_ERRORS,
  },
  getPayout: {
    method: 'GET',
    path: '/v1/payouts/{id}',
    summary: 'One payout with legs, timeline, charges and the rule that allowed it',
    params: PayoutParams,
    query: NoParams,
    response: PayoutDetail,
    errors: DETAIL_ERRORS,
  },
  listReceipts: {
    method: 'GET',
    path: '/v1/receipts',
    summary: 'List receipts, newest first',
    params: NoParams,
    query: ReceiptListQuery,
    response: ReceiptPage,
    errors: LIST_ERRORS,
  },
  getReceipt: {
    method: 'GET',
    path: '/v1/receipts/{id}',
    summary: 'One receipt, in the principal view or, by receipt link, the recipient view',
    params: ReceiptParams,
    query: NoParams,
    response: ReceiptView,
    errors: DETAIL_ERRORS,
  },
  getFunding: {
    method: 'GET',
    path: '/v1/funding',
    summary: 'Balances per asset and network, low-balance state and recent deposits',
    params: NoParams,
    query: FundingQuery,
    response: FundingOverview,
    errors: LIST_ERRORS,
  },
  getOverviewStats: {
    method: 'GET',
    path: '/v1/stats/overview',
    summary: 'The overview numbers for a period, with the previous period for deltas',
    params: NoParams,
    query: OverviewStatsQuery,
    response: OverviewStats,
    errors: LIST_ERRORS,
  },
  listApprovals: {
    method: 'GET',
    path: '/v1/approvals',
    summary: 'Payouts waiting for approval, oldest first',
    params: NoParams,
    query: ApprovalListQuery,
    response: ApprovalPage,
    errors: LIST_ERRORS,
  },
} as const satisfies Record<string, RouteDefinition>;

export type RouteId = keyof typeof ROUTES;
export const ROUTE_IDS = Object.freeze(Object.keys(ROUTES) as RouteId[]);

export type RouteResponse<R extends RouteId> = z.infer<(typeof ROUTES)[R]['response']>;
export type RouteQuery<R extends RouteId> = z.infer<(typeof ROUTES)[R]['query']>;
