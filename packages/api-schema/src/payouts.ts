// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { z } from 'zod';

import {
  CountryCode,
  DisplayName,
  MaskedDestination,
  NetworkId,
  Timestamp,
  TxHash,
  Uuid,
  tenantFields,
} from './common.js';
import { listParam, pageQueryFields } from './envelope.js';
import {
  ALLOWED_PAYOUT_STATUSES,
  AllowedBy,
  CashoutCostBearer,
  LegStatus,
  PayoutMethod,
  PayoutStatus,
  QueuedReason,
  RailId,
} from './enums.js';
import type { PayoutStatus as PayoutStatusValue, TIMELINE_STEPS } from './enums.js';
import {
  FiatCurrency,
  MinorUnits,
  Money,
  Rate,
  TokenAmount,
  amountOf,
  minorUnitsOf,
  tokenSumEquals,
} from './money.js';

/** A mandate rule's error name from the spec, for example DAILY_CAP_EXCEEDED. */
export const SpecErrorName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'a spec error name');

export const ReceiptNumber = z.string().regex(/^R-[0-9A-Z]{12}$/, 'a receipt number');

/** Where a receipt can be checked on chain: network, transaction and event. */
export const ReceiptRef = z
  .string()
  .max(200)
  .regex(
    /^ujira:tx:v1:[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:(0x)?[0-9a-f]{64}:[0-9]{1,10}$/,
    'a receipt reference',
  );

export const RecipientSummary = z.strictObject({
  id: Uuid,
  displayName: DisplayName,
  country: CountryCode.nullable(),
});

export const MandateSummaryRef = z.strictObject({ id: Uuid, name: DisplayName });

// Statuses that need a routed payout, so a settlement amount and network.
const ROUTED: ReadonlySet<PayoutStatusValue> = new Set<PayoutStatusValue>([
  'submitting',
  'pending_approval',
  'approved',
  'settling',
  'delivering',
  'partly_paid',
  'paid',
  'needs_attention',
  'rejected',
]);

// Statuses reached only after the mandate executed the payout.
const SETTLED: ReadonlySet<PayoutStatusValue> = new Set<PayoutStatusValue>([
  'settling',
  'delivering',
  'partly_paid',
  'paid',
  'needs_attention',
]);

const listFields = {
  ...tenantFields,
  id: Uuid,
  recipient: RecipientSummary,
  mandate: MandateSummaryRef,
  /** What the principal asked to pay. */
  requested: Money,
  /** What the recipient gets in their own currency, once quoted. */
  received: Money.nullable(),
  /** The token total the mandate checks, once routed. */
  settlement: TokenAmount.nullable(),
  status: PayoutStatus,
  queuedReason: QueuedReason.nullable(),
  blockedBy: SpecErrorName.nullable(),
  /** The destination country. Null only when the recipient has none on file. */
  corridor: CountryCode.nullable(),
  /** The method of the first leg, or the recipient's main method before routing. */
  method: PayoutMethod,
  legCount: z.number().int().min(0).max(4),
  network: NetworkId.nullable(),
  createdAt: Timestamp,
  settledAt: Timestamp.nullable(),
} as const;

type ListShape = z.infer<z.ZodObject<typeof listFields>>;

function checkListRules(value: ListShape, ctx: z.RefinementCtx): void {
  if (value.queuedReason !== null && value.status !== 'queued') {
    ctx.addIssue({
      code: 'custom',
      path: ['queuedReason'],
      message: 'only a queued payout has a reason to wait',
    });
  }
  if ((value.blockedBy !== null) !== (value.status === 'blocked')) {
    ctx.addIssue({
      code: 'custom',
      path: ['blockedBy'],
      message: 'a blocked payout names its rule, others do not',
    });
  }
  if (ROUTED.has(value.status) && value.settlement === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['settlement'],
      message: 'a routed payout has a settlement amount',
    });
  }
  if ((value.settlement === null) !== (value.network === null)) {
    ctx.addIssue({
      code: 'custom',
      path: ['network'],
      message: 'network and settlement come together',
    });
  }
  if (
    value.settlement !== null &&
    value.network !== null &&
    value.settlement.network !== value.network
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['settlement', 'network'],
      message: 'settles on the payout network',
    });
  }
  if ((value.settledAt !== null) !== SETTLED.has(value.status)) {
    ctx.addIssue({
      code: 'custom',
      path: ['settledAt'],
      message: 'settledAt is set exactly once executed',
    });
  }
  if (value.legCount === 0 && value.settlement !== null) {
    ctx.addIssue({ code: 'custom', path: ['legCount'], message: 'a routed payout has legs' });
  }
}

export const PayoutListItem = z.strictObject(listFields).superRefine(checkListRules);
export type PayoutListItem = z.infer<typeof PayoutListItem>;

/**
 * The anchor's cut and conversion on a local-currency leg. In settlement
 * units, because that is what the leg pays out of.
 */
export const CashOutCosts = z.strictObject({
  bearer: CashoutCostBearer,
  anchorFee: TokenAmount,
  rate: Rate,
});

export const PayoutLeg = z
  .strictObject({
    id: Uuid,
    index: z.number().int().min(0).max(3),
    method: PayoutMethod,
    rail: RailId,
    status: LegStatus,
    amount: TokenAmount,
    /** In the delivery currency, for local methods once quoted. */
    received: Money.nullable(),
    maskedDestination: MaskedDestination,
    anchorName: DisplayName.nullable(),
    cashOut: CashOutCosts.nullable(),
    txHash: TxHash.nullable(),
    anchorTransactionId: z.string().min(1).max(255).nullable(),
    failureReason: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .nullable(),
    replacesLegId: Uuid.nullable(),
    settledAt: Timestamp.nullable(),
    deliveredAt: Timestamp.nullable(),
  })
  .superRefine((leg, ctx) => {
    const wallet = leg.method === 'stellar_wallet';
    if ((leg.rail === 'stellar.wallet') !== wallet) {
      ctx.addIssue({ code: 'custom', path: ['rail'], message: 'rail does not carry that method' });
    }
    if (wallet && (leg.received !== null || leg.cashOut !== null || leg.anchorName !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['method'],
        message: 'a wallet leg has no anchor, quote or local amount',
      });
    }
    if (leg.cashOut !== null && leg.cashOut.rate.quote !== leg.received?.currency) {
      ctx.addIssue({
        code: 'custom',
        path: ['cashOut', 'rate'],
        message: 'the rate converts into the received currency',
      });
    }
    if ((leg.deliveredAt !== null) !== (leg.status === 'delivered')) {
      ctx.addIssue({
        code: 'custom',
        path: ['deliveredAt'],
        message: 'deliveredAt is set exactly when delivered',
      });
    }
    const settled = ['settled', 'delivering', 'delivered'].includes(leg.status);
    if (settled && (leg.txHash === null || leg.settledAt === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['txHash'],
        message: 'a settled leg has its transaction',
      });
    }
    if ((leg.failureReason !== null) !== (leg.status === 'failed')) {
      ctx.addIssue({
        code: 'custom',
        path: ['failureReason'],
        message: 'only a failed leg has a reason',
      });
    }
  });
export type PayoutLeg = z.infer<typeof PayoutLeg>;

/** What the principal pays: the recipient's total plus the take. */
export const PayoutCharges = z
  .strictObject({
    settlement: TokenAmount,
    take: TokenAmount,
    takeBps: z.number().int().min(0).max(100),
    charged: TokenAmount,
  })
  .superRefine((value, ctx) => {
    if (!tokenSumEquals([value.settlement, value.take], value.charged)) {
      ctx.addIssue({
        code: 'custom',
        path: ['charged'],
        message: 'charged must equal settlement plus take',
      });
      return;
    }
    // The same cap the contract enforces, computed without overflow.
    const total = amountOf(value.settlement);
    const take = amountOf(value.take);
    // Defensive, not a reachable path: the field's own check refuses a
    // fractional rate before this runs. Kept so the conversion is safe on
    // its own terms rather than through the order the checks happen in.
    if (total === undefined || take === undefined || !Number.isSafeInteger(value.takeBps)) return;
    const bps = BigInt(value.takeBps);
    const cap = (total / 10000n) * bps + ((total % 10000n) * bps) / 10000n;
    if (take > cap) {
      ctx.addIssue({ code: 'custom', path: ['take'], message: 'take is above the rate cap' });
    }
  });

const timelineEntry = <S extends (typeof TIMELINE_STEPS)[number]>(step: S) =>
  z.strictObject({ step: z.literal(step), at: Timestamp.nullable() });

/** Always all five steps in order; a step not reached yet has no time. */
export const PayoutTimeline = z
  .tuple([
    timelineEntry('requested'),
    timelineEntry('approved'),
    timelineEntry('quoted'),
    timelineEntry('settled'),
    timelineEntry('delivered'),
  ])
  .superRefine((steps, ctx) => {
    if (steps[0].at === null) {
      ctx.addIssue({ code: 'custom', path: [0, 'at'], message: 'every payout was requested' });
    }
    let last = Number.NEGATIVE_INFINITY;
    steps.forEach((entry, i) => {
      if (entry.at === null) return;
      const at = Date.parse(entry.at);
      if (at < last) {
        ctx.addIssue({ code: 'custom', path: [i, 'at'], message: 'steps happen in order' });
      }
      last = at;
    });
  });

/**
 * given may exceed required: the principal can lower the requirement after
 * approvals were already given, and the mandate keeps those approvals. Both
 * counts are bounded because approving stops once the requirement is met.
 */
export const ApprovalCount = z.strictObject({
  given: z.number().int().min(0).max(10),
  required: z.number().int().min(0).max(10),
});

export const PayoutReceiptLink = z.strictObject({
  id: Uuid,
  receiptNumber: ReceiptNumber,
  receiptRef: ReceiptRef,
});

export const PayoutDetail = z
  .strictObject({
    ...listFields,
    taskId: z.string().min(1).max(255).nullable(),
    legs: z.array(PayoutLeg).max(16),
    charges: PayoutCharges.nullable(),
    cashOutBearer: CashoutCostBearer,
    timeline: PayoutTimeline,
    allowedBy: AllowedBy.nullable(),
    approvals: ApprovalCount,
    receipt: PayoutReceiptLink.nullable(),
    updatedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    checkListRules(value, ctx);
    if (ALLOWED_PAYOUT_STATUSES.has(value.status) && value.allowedBy === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedBy'],
        message: 'an allowed payout names the rule that allowed it',
      });
    }
    if (
      ['queued', 'submitting', 'pending_approval', 'blocked', 'rejected'].includes(value.status) &&
      value.allowedBy !== null
    ) {
      ctx.addIssue({ code: 'custom', path: ['allowedBy'], message: 'not allowed yet' });
    }
    if ((value.receipt !== null) !== (value.status === 'paid')) {
      ctx.addIssue({
        code: 'custom',
        path: ['receipt'],
        message: 'a receipt exists exactly once paid',
      });
    }
    if ((value.charges === null) !== (value.settlement === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['charges'],
        message: 'charges come with the settlement amount',
      });
    }
    if (
      value.charges !== null &&
      value.settlement !== null &&
      !tokenSumEquals([value.charges.settlement], value.settlement)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['charges', 'settlement'],
        message: 'charges restate the settlement amount',
      });
    }
    const live = value.legs.filter(
      (leg) => !value.legs.some((other) => other.replacesLegId === leg.id),
    );
    if (live.length !== value.legCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['legCount'],
        message: 'legCount counts the legs not replaced',
      });
    }
    if (
      value.settlement !== null &&
      live.length > 0 &&
      !tokenSumEquals(
        live.map((leg) => leg.amount),
        value.settlement,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['legs'],
        message: 'legs add up to the settlement amount',
      });
    }
    const first = live[0];
    if (first !== undefined && first.method !== value.method) {
      ctx.addIssue({ code: 'custom', path: ['method'], message: 'method is the first leg method' });
    }
  });
export type PayoutDetail = z.infer<typeof PayoutDetail>;

export const PayoutListQuery = z
  .strictObject({
    ...pageQueryFields,
    status: listParam(PayoutStatus).optional(),
    corridor: listParam(CountryCode, 250).optional(),
    method: listParam(PayoutMethod).optional(),
    mandateId: listParam(Uuid).optional(),
    network: listParam(NetworkId).optional(),
    /** The amount range applies to the requested amount in this currency. */
    amountCurrency: FiatCurrency.optional(),
    amountMin: MinorUnits.optional(),
    amountMax: MinorUnits.optional(),
    createdFrom: Timestamp.optional(),
    createdTo: Timestamp.optional(),
  })
  .superRefine((value, ctx) => {
    const ranged = value.amountMin !== undefined || value.amountMax !== undefined;
    if (ranged && value.amountCurrency === undefined) {
      ctx.addIssue({ code: 'custom', path: ['amountCurrency'], message: 'currency_required' });
    }
    const min = minorUnitsOf(value.amountMin);
    const max = minorUnitsOf(value.amountMax);
    // A bound the field schema already rejected has its own issue, so the
    // range rule stays quiet rather than converting text that cannot convert.
    if (min !== undefined && max !== undefined && min > max) {
      ctx.addIssue({ code: 'custom', path: ['amountMin'], message: 'range_inverted' });
    }
    if (
      value.createdFrom !== undefined &&
      value.createdTo !== undefined &&
      Date.parse(value.createdFrom) > Date.parse(value.createdTo)
    ) {
      ctx.addIssue({ code: 'custom', path: ['createdFrom'], message: 'range_inverted' });
    }
  });
export type PayoutListQuery = z.infer<typeof PayoutListQuery>;

export const PayoutParams = z.strictObject({ id: Uuid });
