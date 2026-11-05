// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Reading a receipt: the principal's copy, the files a principal keeps, and the
// public check anyone holding a receipt can make. The amounts always come from
// the stored document, the one thing that is hashed. The rest of the principal's
// copy, such as who approved it, comes from the payout's own records, through a
// port until those tables and the receipts tables are in.

import {
  PrincipalReceipt,
  PublicReceiptVerification,
  toWireMoney,
  toWireToken,
} from '@ujira/api-schema';
import type { CallOptions, TenantScope } from '@ujira/chain-adapter';
import { sum, tokenAmount } from '@ujira/core';
import { VERIFICATION_CODE, receiptPdf, receiptsCsv } from '@ujira/receipts';
import type { PublicVerification, PublicVerificationRequest, StoredReceipt } from '@ujira/receipts';
import { z } from 'zod';

import type { Tenant } from '../auth.js';
import { ApiError } from '../errors.js';
import {
  contractRoute,
  defineDownloadRoute,
  definePublicRoute,
  defineTenantRoute,
} from '../route.js';
import type { Route } from '../route.js';

type WireLeg = PrincipalReceipt['legs'][number];

/** What the payout's own records add to a leg of the principal's copy. */
export type PrincipalLegContext = Pick<
  WireLeg,
  'rail' | 'anchorName' | 'cashOut' | 'anchorTransactionId' | 'deliveredAt'
>;

/** What the payout's own records add to the principal's copy. */
export type PrincipalReceiptContext = Pick<
  PrincipalReceipt,
  | 'verifyUrl'
  | 'payerDisplayName'
  | 'deliveredAt'
  | 'recipient'
  | 'attempt'
  | 'allowedBy'
  | 'approvals'
  | 'timeline'
> & { readonly legs: readonly PrincipalLegContext[] };

export interface PrincipalReceiptRecord {
  readonly id: string;
  readonly supersedesReceiptId: string | null;
  readonly stored: StoredReceipt;
  readonly context: PrincipalReceiptContext;
}

export interface ReceiptExportFilter {
  readonly payoutId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
}

/** What the receipt routes read through. Every tenant read takes the tenant. */
export interface ReceiptReads {
  principalReceipt(tenant: Tenant, id: string): Promise<PrincipalReceiptRecord | null>;
  /** The latest revision of a payout's receipt. */
  payoutReceipt(tenant: Tenant, payoutId: string): Promise<PrincipalReceiptRecord | null>;
  exportRows(tenant: Tenant, filter: ReceiptExportFilter): Promise<readonly StoredReceipt[]>;
  /** The public check. It takes no tenant, and answers with nothing that belongs to one. */
  verify(req: PublicVerificationRequest, opts: CallOptions): Promise<PublicVerification | null>;
}

/**
 * Stands in until the receipts tables are in. Nothing can be read, and a client
 * can try again later.
 */
export const RECEIPTS_NOT_CONFIGURED: ReceiptReads = Object.freeze({
  principalReceipt: () => Promise.reject(new ApiError('DB_UNAVAILABLE')),
  payoutReceipt: () => Promise.reject(new ApiError('DB_UNAVAILABLE')),
  exportRows: () => Promise.reject(new ApiError('DB_UNAVAILABLE')),
  verify: () => Promise.reject(new ApiError('DB_UNAVAILABLE')),
});

/** The largest set one export returns. */
export const RECEIPT_EXPORT_MAX = 1_000;

function scopeOf(tenant: Tenant): TenantScope {
  return { principalId: tenant.principalId, projectId: tenant.projectId } as TenantScope;
}

function txHashOf(receiptRef: string): string {
  // ujira:tx:v1:{network}:{hash}:{index}. The model checked the form when it
  // built the receipt, so the hash is the second part from the end.
  return receiptRef.split(':').at(-2) ?? '';
}

/** The principal's copy on the wire: the document's figures and the payout's context. */
export function toPrincipalReceipt(record: PrincipalReceiptRecord): PrincipalReceipt {
  const { id, supersedesReceiptId, stored, context } = record;
  const { receipt } = stored;
  const { network } = receipt;
  const token = (value: Parameters<typeof toWireToken>[0]) => toWireToken(value, network);
  const refunded =
    receipt.feeRefunds.length === 0
      ? tokenAmount(0n, receipt.fee.amount.asset, receipt.fee.amount.chain)
      : sum(receipt.feeRefunds.map((refund) => refund.amount));
  return {
    view: 'principal',
    principalId: receipt.principalId,
    projectId: receipt.projectId,
    receiptNumber: receipt.receiptNumber,
    revision: receipt.revision,
    issuedAt: receipt.issuedAt,
    verifyUrl: context.verifyUrl,
    payerDisplayName: context.payerDisplayName,
    status: 'paid',
    deliveredAt: context.deliveredAt,
    documentSha256: stored.documentSha256,
    id,
    supersedesReceiptId,
    receiptRef: receipt.receiptRef,
    payoutId: receipt.payoutId,
    taskId: receipt.taskId,
    mandateId: receipt.mandate.id,
    recipient: context.recipient,
    recipientRef: receipt.recipientRef,
    attempt: context.attempt,
    requested: toWireMoney(receipt.requested),
    settlement: token(receipt.total),
    take: token(receipt.fee.amount),
    takeBps: receipt.fee.bps,
    takeRefunded: token(refunded),
    charged: token(receipt.charged),
    legs: receipt.legs.map((leg, i) => {
      const extra = context.legs[i];
      // A leg the payout does not know about cannot be described, and the
      // pipeline answers 500 rather than make the rest of it up.
      if (extra === undefined) throw new ApiError('INTERNAL');
      return {
        index: leg.index,
        method: leg.method,
        rail: extra.rail,
        network,
        amount: token(leg.amount),
        received: leg.received === null ? null : toWireMoney(leg.received),
        maskedDestination: leg.destination.masked,
        anchorName: extra.anchorName,
        cashOut: extra.cashOut,
        txHash: txHashOf(leg.receiptRef),
        anchorTransactionId: extra.anchorTransactionId,
        deliveredAt: extra.deliveredAt,
      };
    }),
    allowedBy: context.allowedBy,
    approvals: context.approvals,
    timeline: context.timeline,
  };
}

const PayoutParams = z.strictObject({ id: z.uuid() });
const ReceiptIdParams = z.strictObject({ id: z.uuid() });

const ExportQuery = z.strictObject({
  payoutId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

const VerificationParams = z.strictObject({
  receiptNumber: z.string().regex(/^R-[0-9A-Z]{12}$/),
});

function isLocale(text: string): boolean {
  try {
    return Intl.getCanonicalLocales(text).length === 1;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

const VerificationQuery = z.strictObject({
  code: z.string().regex(VERIFICATION_CODE),
  locale: z.string().max(35).refine(isLocale).default('en-US'),
});

function found<T>(value: T | null): T {
  if (value === null) throw new ApiError('NOT_FOUND');
  return value;
}

export function receiptRoutes(reads: ReceiptReads): readonly Route[] {
  return [
    contractRoute('getReceipt', {
      scope: 'receipts:read',
      handler: async ({ params }, { tenant }) =>
        toPrincipalReceipt(found(await reads.principalReceipt(tenant, params.id))),
    }),
    defineTenantRoute({
      id: 'getPayoutReceipt',
      method: 'GET',
      path: '/v1/payouts/{id}/receipt',
      summary: "The latest revision of a payout's receipt, in the principal view",
      scope: 'receipts:read',
      params: PayoutParams,
      response: { name: 'PrincipalReceipt', schema: PrincipalReceipt },
      errors: ['NOT_FOUND'],
      handler: async ({ params }, { tenant }) =>
        toPrincipalReceipt(found(await reads.payoutReceipt(tenant, params.id))),
    }),
    defineDownloadRoute({
      id: 'exportReceipts',
      path: '/v1/receipt-exports',
      summary: 'A filtered set of receipts as CSV, with the canonical document in each row',
      scope: 'receipts:read',
      contentType: 'text/csv; charset=utf-8',
      query: ExportQuery,
      handler: async ({ query }, { tenant }) => {
        const rows = await reads.exportRows(tenant, {
          ...(query.payoutId === undefined ? {} : { payoutId: query.payoutId }),
          ...(query.from === undefined ? {} : { from: query.from }),
          ...(query.to === undefined ? {} : { to: query.to }),
          limit: RECEIPT_EXPORT_MAX,
        });
        return { filename: 'receipts.csv', body: receiptsCsv(scopeOf(tenant), rows) };
      },
    }),
    defineDownloadRoute({
      id: 'getReceiptPdf',
      path: '/v1/receipts/{id}/pdf',
      summary: 'One receipt as a PDF',
      scope: 'receipts:read',
      contentType: 'application/pdf',
      params: ReceiptIdParams,
      errors: ['NOT_FOUND'],
      handler: async ({ params }, { tenant }) => {
        const { stored } = found(await reads.principalReceipt(tenant, params.id));
        // The file skips the check made on every JSON body, so it is made here.
        if (
          stored.receipt.principalId !== tenant.principalId ||
          stored.receipt.projectId !== tenant.projectId
        ) {
          throw new ApiError('INTERNAL');
        }
        return { filename: `${stored.receipt.receiptNumber}.pdf`, body: receiptPdf(stored) };
      },
    }),
    definePublicRoute({
      id: 'verifyReceipt',
      method: 'GET',
      path: '/v1/receipt-verifications/{receiptNumber}',
      summary: 'Check a receipt by its number and verification code',
      reason:
        'Anyone holding a receipt can check it without trusting UJIRA. The code printed on the receipt stands in for a key, and the answer holds nothing that belongs to a tenant.',
      params: VerificationParams,
      query: VerificationQuery,
      response: { name: 'PublicReceiptVerification', schema: PublicReceiptVerification },
      errors: ['NOT_FOUND'],
      handler: async ({ params, query }, { call }) => {
        const outcome = found(
          await reads.verify(
            { receiptNumber: params.receiptNumber, code: query.code, locale: query.locale },
            call,
          ),
        );
        return {
          status: outcome.status,
          reason: outcome.reason,
          receipt:
            outcome.receipt === null
              ? null
              : { ...outcome.receipt, legs: [...outcome.receipt.legs] },
        };
      },
    }),
  ];
}
