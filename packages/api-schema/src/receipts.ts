// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { z } from 'zod';

import {
  DisplayName,
  MaskedDestination,
  NetworkId,
  Sha256Hex,
  Timestamp,
  TxHash,
  Uuid,
  tenantFields,
} from './common.js';
import { pageQueryFields } from './envelope.js';
import { AllowedBy, LocalPayoutMethod, PayoutMethod, RailId } from './enums.js';
import { Money, Rate, TokenAmount, amountOf, tokenSumEquals } from './money.js';
import {
  ApprovalCount,
  CashOutCosts,
  PayoutTimeline,
  ReceiptNumber,
  ReceiptRef,
  RecipientSummary,
} from './payouts.js';

const HttpsUrl = z.url({ protocol: /^https$/ });

/** Per project. Whether recipient receipts name the payer. */
export const ReceiptSettings = z.strictObject({ showPayerName: z.boolean() });
export type ReceiptSettings = z.infer<typeof ReceiptSettings>;

export const DEFAULT_RECEIPT_SETTINGS = Object.freeze({ showPayerName: true } as const);

const receiptFields = {
  receiptNumber: ReceiptNumber,
  revision: z.number().int().min(1),
  issuedAt: Timestamp,
  verifyUrl: HttpsUrl,
  /** Null only when the project turned showPayerName off. */
  payerDisplayName: DisplayName.nullable(),
  status: z.literal('paid'),
  deliveredAt: Timestamp,
  documentSha256: Sha256Hex,
} as const;

export const PrincipalReceiptLeg = z
  .strictObject({
    index: z.number().int().min(0).max(3),
    method: PayoutMethod,
    rail: RailId,
    network: NetworkId,
    amount: TokenAmount,
    received: Money.nullable(),
    maskedDestination: MaskedDestination,
    anchorName: DisplayName.nullable(),
    cashOut: CashOutCosts.nullable(),
    txHash: TxHash,
    anchorTransactionId: z.string().min(1).max(255).nullable(),
    deliveredAt: Timestamp,
  })
  .superRefine((leg, ctx) => {
    if (leg.amount.network !== leg.network) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount', 'network'],
        message: 'the leg settles on its network',
      });
    }
    if ((leg.method === 'stellar_wallet') !== (leg.received === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['received'],
        message: 'local legs state the local amount, wallet legs do not',
      });
    }
  });

/** The principal's copy: commercial terms, every id and every hash. */
export const PrincipalReceipt = z
  .strictObject({
    view: z.literal('principal'),
    ...tenantFields,
    ...receiptFields,
    id: Uuid,
    supersedesReceiptId: Uuid.nullable(),
    receiptRef: ReceiptRef,
    payoutId: Uuid,
    taskId: z.string().min(1).max(255).nullable(),
    mandateId: Uuid,
    recipient: RecipientSummary,
    recipientRef: Sha256Hex,
    attempt: z.number().int().min(0),
    requested: Money,
    settlement: TokenAmount,
    take: TokenAmount,
    takeBps: z.number().int().min(0).max(100),
    takeRefunded: TokenAmount,
    charged: TokenAmount,
    legs: z.array(PrincipalReceiptLeg).min(1).max(4),
    allowedBy: AllowedBy,
    approvals: ApprovalCount,
    timeline: PayoutTimeline,
  })
  .superRefine((value, ctx) => {
    if ((value.revision === 1) !== (value.supersedesReceiptId === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['supersedesReceiptId'],
        message: 'a revision after the first supersedes one',
      });
    }
    if (!tokenSumEquals([value.settlement, value.take], value.charged)) {
      ctx.addIssue({
        code: 'custom',
        path: ['charged'],
        message: 'charged must equal settlement plus take',
      });
    }
    if (
      !tokenSumEquals(
        value.legs.map((leg) => leg.amount),
        value.settlement,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['legs'],
        message: 'legs add up to the settlement amount',
      });
    }
    const refunded = amountOf(value.takeRefunded);
    const take = amountOf(value.take);
    if (refunded !== undefined && take !== undefined && refunded > take) {
      ctx.addIssue({
        code: 'custom',
        path: ['takeRefunded'],
        message: 'cannot refund more than the take',
      });
    }
  });
export type PrincipalReceipt = z.infer<typeof PrincipalReceipt>;

/**
 * A recipient reads the rate as "1 USD = 1,600.25 NGN": against the dollar,
 * never the token, and into the currency they received.
 */
const RecipientRate = Rate.refine((rate) => rate.base === 'USD', {
  message: 'quote the rate against USD',
  path: ['base'],
});

/** The anchor's fee in the recipient's own currency, and the rate, when they bore them. */
export const RecipientCashOutCosts = z.strictObject({ anchorFee: Money, rate: RecipientRate });

export const RecipientWalletLeg = z.strictObject({
  method: z.literal('stellar_wallet'),
  received: TokenAmount,
  maskedDestination: MaskedDestination,
  txHash: TxHash,
  explorerUrl: HttpsUrl,
});

/**
 * A local-currency leg carries no token, network or transaction hash: the
 * recipient chose to be paid in their own currency and sees only that.
 */
export const RecipientLocalLeg = z
  .strictObject({
    method: LocalPayoutMethod,
    received: Money,
    maskedDestination: MaskedDestination,
    anchorName: DisplayName,
    costs: RecipientCashOutCosts.nullable(),
  })
  .superRefine((leg, ctx) => {
    if (leg.costs !== null && leg.costs.anchorFee.currency !== leg.received.currency) {
      ctx.addIssue({
        code: 'custom',
        path: ['costs', 'anchorFee'],
        message: 'the fee is in the received currency',
      });
    }
    if (leg.costs !== null && leg.costs.rate.quote !== leg.received.currency) {
      ctx.addIssue({
        code: 'custom',
        path: ['costs', 'rate'],
        message: 'the rate converts into the received currency',
      });
    }
  });

export const RecipientReceiptLeg = z.discriminatedUnion('method', [
  RecipientWalletLeg,
  RecipientLocalLeg,
]);

/** The recipient's copy, served by receipt link or embed session only. */
export const RecipientReceipt = z
  .strictObject({
    view: z.literal('recipient'),
    ...receiptFields,
    /**
     * The receipt a correction replaced, by number rather than id, so a
     * recipient can match it to the copy they already hold without ever
     * being handed an internal identifier.
     */
    supersedes: ReceiptNumber.nullable(),
    legs: z.array(RecipientReceiptLeg).min(1).max(4),
  })
  .superRefine((value, ctx) => {
    if ((value.revision === 1) !== (value.supersedes === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['supersedes'],
        message: 'a revision after the first supersedes one',
      });
    }
  });
export type RecipientReceipt = z.infer<typeof RecipientReceipt>;

export const ReceiptView = z.discriminatedUnion('view', [PrincipalReceipt, RecipientReceipt]);
export type ReceiptView = z.infer<typeof ReceiptView>;

const PublicWalletLeg = z.strictObject({
  method: z.literal('stellar_wallet'),
  label: z.string().min(1).max(100),
  received: z.string().min(1).max(64),
  destination: MaskedDestination,
  network: DisplayName,
  transactionHash: TxHash,
  transactionUrl: HttpsUrl,
});

/** Only the local amount and where it went: no token, network or transaction. */
const PublicLocalLeg = z.strictObject({
  method: LocalPayoutMethod,
  label: z.string().min(1).max(100),
  received: z.string().min(1).max(64),
  destination: MaskedDestination,
});

/** The recipient view as anyone holding the receipt sees it, formatted for their locale. */
export const PublicReceipt = z.strictObject({
  view: z.literal('recipient'),
  receiptNumber: ReceiptNumber,
  revision: z.number().int().min(1),
  supersedes: ReceiptNumber.nullable(),
  issuedAt: Timestamp,
  total: z.string().min(1).max(64),
  summary: z.string().min(1).max(500),
  legs: z
    .array(z.discriminatedUnion('method', [PublicWalletLeg, PublicLocalLeg]))
    .min(1)
    .max(4),
});

/**
 * The public check of a receipt. It carries no tenant, mandate or destination
 * tag, and its reasons name no chain, because it is also read by someone paid
 * in local currency. A document that no longer matches its hash shows no
 * receipt, since what is stored can no longer be believed.
 */
export const PublicReceiptVerification = z.strictObject({
  status: z.enum(['verified', 'failed', 'unavailable']),
  reason: z.enum(['not_confirmed', 'document_changed']).nullable(),
  receipt: PublicReceipt.nullable(),
});
export type PublicReceiptVerification = z.infer<typeof PublicReceiptVerification>;

export const ReceiptListItem = z.strictObject({
  ...tenantFields,
  id: Uuid,
  payoutId: Uuid,
  receiptNumber: ReceiptNumber,
  revision: z.number().int().min(1),
  issuedAt: Timestamp,
  recipient: RecipientSummary,
  requested: Money,
  charged: TokenAmount,
});
export type ReceiptListItem = z.infer<typeof ReceiptListItem>;

export const ReceiptListQuery = z.strictObject({
  ...pageQueryFields,
  payoutId: Uuid.optional(),
});

export const ReceiptParams = z.strictObject({ id: Uuid });
