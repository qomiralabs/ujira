// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The document is what a receipt hash covers and what an export carries.
// Amounts are decimal strings at the value's own scale ("96.0000000" USDC,
// "336000.00" NGN), so no reader ever has to round-trip money through a
// float and the scale is part of what is hashed.

import { MoneyError, parseMoney, parseTokenAmount, toDecimalString } from '@ujira/core';
import type { Chain, FiatCurrencyCode, Money, TokenAmount, TokenAsset } from '@ujira/core';
import { chainOf, isNetworkId } from '@ujira/chain-adapter';
import { z } from 'zod';

import { canonicalJson, sha256Hex } from './canonical.js';
import { ReceiptInvalidError } from './errors.js';
import { MAX_RECEIPT_LEGS, buildReceipt } from './model.js';
import type { PayoutMethod, Receipt, ReceiptInput } from './model.js';

/** Names the document layout. A change to the layout is a new format, never an edit. */
export const RECEIPT_DOCUMENT_FORMAT = 'ujira.receipt.v1';

export interface AmountDocument {
  /** Plain decimal at the value's scale, ASCII, never a negative zero. */
  readonly amount: string;
  /** ISO 4217 for fiat, the asset code for a settlement token. */
  readonly currency: string;
}

export interface ReceiptLegDocument {
  readonly index: number;
  readonly method: PayoutMethod;
  readonly destination: { readonly masked: string; readonly tag: string | null };
  readonly amount: AmountDocument;
  readonly received: AmountDocument | null;
  readonly railFee: AmountDocument;
  readonly receiptRef: string;
}

export interface ReceiptDocument {
  readonly format: typeof RECEIPT_DOCUMENT_FORMAT;
  readonly principalId: string;
  readonly projectId: string;
  readonly receiptNumber: string;
  readonly revision: number;
  readonly supersedes: { readonly receiptNumber: string; readonly documentSha256: string } | null;
  readonly issuedAt: string;
  readonly payoutId: string;
  readonly taskId: string | null;
  readonly mandate: { readonly id: string; readonly name: string };
  readonly recipientRef: string;
  readonly network: string;
  readonly receiptRef: string;
  readonly requested: AmountDocument;
  readonly total: AmountDocument;
  readonly fee: AmountDocument & { readonly bps: number };
  readonly charged: AmountDocument;
  readonly feeRefunds: readonly { readonly amount: AmountDocument; readonly receiptRef: string }[];
  readonly legs: readonly ReceiptLegDocument[];
}

function amountDocument(value: Money | TokenAmount): AmountDocument {
  return {
    amount: toDecimalString(value),
    currency: value.kind === 'fiat' ? value.currency : value.asset,
  };
}

/** The receipt as a plain JSON document, ready to hash or export. */
export function receiptDocument(receipt: Receipt): ReceiptDocument {
  return {
    format: RECEIPT_DOCUMENT_FORMAT,
    principalId: receipt.principalId,
    projectId: receipt.projectId,
    receiptNumber: receipt.receiptNumber,
    revision: receipt.revision,
    supersedes:
      receipt.supersedes === null
        ? null
        : {
            receiptNumber: receipt.supersedes.receiptNumber,
            documentSha256: receipt.supersedes.documentSha256,
          },
    issuedAt: receipt.issuedAt,
    payoutId: receipt.payoutId,
    taskId: receipt.taskId,
    mandate: { id: receipt.mandate.id, name: receipt.mandate.name },
    recipientRef: receipt.recipientRef,
    network: receipt.network,
    receiptRef: receipt.receiptRef,
    requested: amountDocument(receipt.requested),
    total: amountDocument(receipt.total),
    fee: { ...amountDocument(receipt.fee.amount), bps: receipt.fee.bps },
    charged: amountDocument(receipt.charged),
    feeRefunds: receipt.feeRefunds.map((refund) => ({
      amount: amountDocument(refund.amount),
      receiptRef: refund.receiptRef,
    })),
    legs: receipt.legs.map((leg) => ({
      index: leg.index,
      method: leg.method,
      destination: {
        masked: leg.destination.masked,
        // A u64 does not fit a safe integer, so it travels as text like money.
        tag: leg.destination.tag === null ? null : leg.destination.tag.toString(),
      },
      amount: amountDocument(leg.amount),
      received: leg.received === null ? null : amountDocument(leg.received),
      railFee: amountDocument(leg.railFee),
      receiptRef: leg.receiptRef,
    })),
  };
}

/** The canonical JSON text of the receipt's document, the exact bytes the hash covers. */
export function canonicalReceipt(receipt: Receipt): string {
  return canonicalJson(receiptDocument(receipt));
}

/** Lowercase hex SHA-256 over the canonical document. */
export function documentSha256(receipt: Receipt): string {
  return sha256Hex(canonicalReceipt(receipt));
}

// The shape only. Every value is then rebuilt and checked by the model, and
// the result must reproduce the document exactly.
const Amount = z.strictObject({
  amount: z
    .string()
    .max(64)
    .regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
  currency: z.string().min(1).max(12),
});
const RefText = z.string().max(128);

const DocumentSchema = z.strictObject({
  format: z.literal(RECEIPT_DOCUMENT_FORMAT),
  principalId: z.string(),
  projectId: z.string(),
  receiptNumber: z.string(),
  revision: z.number(),
  supersedes: z.strictObject({ receiptNumber: z.string(), documentSha256: z.string() }).nullable(),
  issuedAt: z.string(),
  payoutId: z.string(),
  taskId: z.string().nullable(),
  mandate: z.strictObject({ id: z.string(), name: z.string() }),
  recipientRef: z.string(),
  network: z.string(),
  receiptRef: RefText,
  requested: Amount,
  total: Amount,
  fee: Amount.extend({ bps: z.number() }),
  charged: Amount,
  feeRefunds: z
    .array(z.strictObject({ amount: Amount, receiptRef: RefText }))
    .max(MAX_RECEIPT_LEGS),
  legs: z
    .array(
      z.strictObject({
        index: z.number(),
        method: z.string(),
        destination: z.strictObject({
          masked: z.string(),
          tag: z
            .string()
            .regex(/^(?:0|[1-9][0-9]{0,19})$/)
            .nullable(),
        }),
        amount: Amount,
        received: Amount.nullable(),
        railFee: Amount,
        receiptRef: RefText,
      }),
    )
    .max(MAX_RECEIPT_LEGS),
});

// Collects every amount that does not parse, so one error lists them all.
class Reader {
  readonly issues: string[] = [];

  constructor(private readonly chain: Chain) {}

  token(path: string, value: { amount: string; currency: string }): TokenAmount | undefined {
    return this.read(path, () =>
      parseTokenAmount(value.amount, value.currency as TokenAsset, this.chain),
    );
  }

  fiat(path: string, value: { amount: string; currency: string }): Money | undefined {
    return this.read(path, () => parseMoney(value.amount, value.currency as FiatCurrencyCode));
  }

  private read<T>(path: string, run: () => T): T | undefined {
    try {
      return run();
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      this.issues.push(`${path} (${error.code})`);
      return undefined;
    }
  }
}

/**
 * Reads a receipt back from a document, for example one a verifier was
 * handed. The shape is checked with zod, every value goes back through the
 * model, and the document must be exactly the canonical form of the
 * receipt it describes: a "1.5" where the scale needs "1.5000000", a
 * charged amount that is not total plus fee, or anything else that would
 * not hash the same, throws ReceiptInvalidError.
 */
export function parseReceiptDocument(value: unknown): Receipt {
  const parsed = DocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new ReceiptInvalidError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.length === 0 ? '$' : issue.path.map(String).join('.');
        return `${path} (${issue.code})`;
      }),
    );
  }
  const doc = parsed.data;
  if (!isNetworkId(doc.network)) throw new ReceiptInvalidError(['network (unknown)']);
  const reader = new Reader(chainOf(doc.network));
  const total = reader.token('total', doc.total);
  const requested = reader.fiat('requested', doc.requested);
  const fee = reader.token('fee', doc.fee);
  const refunds = doc.feeRefunds.map((refund, i) => ({
    amount: reader.token(`feeRefunds.${String(i)}.amount`, refund.amount),
    receiptRef: refund.receiptRef,
  }));
  const legs = doc.legs.map((leg, i) => ({
    index: leg.index,
    method: leg.method as PayoutMethod,
    destination: {
      masked: leg.destination.masked,
      tag: leg.destination.tag === null ? null : BigInt(leg.destination.tag),
    },
    amount: reader.token(`legs.${String(i)}.amount`, leg.amount),
    received:
      leg.received === null ? null : reader.fiat(`legs.${String(i)}.received`, leg.received),
    railFee: reader.token(`legs.${String(i)}.railFee`, leg.railFee),
    receiptRef: leg.receiptRef,
  }));
  if (reader.issues.length > 0) throw new ReceiptInvalidError(reader.issues);
  // Every amount was read, so none of these is undefined any more; the model
  // checks them again regardless.
  const input = {
    principalId: doc.principalId,
    projectId: doc.projectId,
    receiptNumber: doc.receiptNumber,
    revision: doc.revision,
    supersedes: doc.supersedes,
    issuedAt: doc.issuedAt,
    payoutId: doc.payoutId,
    taskId: doc.taskId,
    mandate: doc.mandate,
    recipientRef: doc.recipientRef,
    network: doc.network,
    receiptRef: doc.receiptRef,
    requested,
    total,
    fee: { amount: fee, bps: doc.fee.bps },
    feeRefunds: refunds,
    legs,
  } as unknown as ReceiptInput;
  const receipt = buildReceipt(input);
  if (canonicalReceipt(receipt) !== canonicalJson(doc)) {
    throw new ReceiptInvalidError(['$ (the document is not the canonical form of its receipt)']);
  }
  return receipt;
}
