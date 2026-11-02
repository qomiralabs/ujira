// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// One receipt per payout, whatever its legs, in one chain-neutral shape. The
// model takes the payout as the rest of the system recorded it and refuses
// anything that does not add up, because a receipt is permanent: a wrong one
// can only be corrected by issuing a new revision, never by editing it.

import { MoneyError, add, compare, money, sum, tokenAmount } from '@ujira/core';
import type { Chain, FiatCurrencyCode, Money, TokenAmount, TokenAsset } from '@ujira/core';
import {
  InvalidInputError,
  chainOf,
  formatReceiptRef,
  isNetworkId,
  parseReceiptRef,
} from '@ujira/chain-adapter';
import type { NetworkId, ReceiptRef } from '@ujira/chain-adapter';
import { z } from 'zod';

import { ReceiptInvalidError } from './errors.js';

/** Methods paid out in the recipient's own currency through an anchor. */
export const LOCAL_PAYOUT_METHODS = Object.freeze(['bank', 'mobile_money', 'cash_pickup'] as const);
/** Methods paid in the settlement token to a wallet the recipient holds. */
export const WALLET_PAYOUT_METHODS = Object.freeze(['stellar_wallet'] as const);

export type LocalPayoutMethod = (typeof LOCAL_PAYOUT_METHODS)[number];
export type WalletPayoutMethod = (typeof WALLET_PAYOUT_METHODS)[number];
export type PayoutMethod = LocalPayoutMethod | WalletPayoutMethod;

const WALLET_METHODS: ReadonlySet<unknown> = new Set<unknown>(WALLET_PAYOUT_METHODS);

export function isWalletMethod(method: PayoutMethod): method is WalletPayoutMethod {
  return WALLET_METHODS.has(method);
}

/** Most legs one payout is split into, the same bound the API applies. */
export const MAX_RECEIPT_LEGS = 4;

/** The highest fee rate any mandate can carry, in basis points. */
export const MAX_FEE_BPS = 100;

const U64_MAX = 2n ** 64n - 1n;

export interface ReceiptDestination {
  /** Masked for display, never the full account number. */
  readonly masked: string;
  /** The destination tag or memo ID, a u64, when the destination needs one. */
  readonly tag: bigint | null;
}

interface ReceiptLegBase {
  /** Position in the payout, from 0 in order. */
  readonly index: number;
  readonly destination: ReceiptDestination;
  /** What the leg sent on chain, in the settlement token. */
  readonly amount: TokenAmount;
  /** What the rail kept for delivering the leg, in the settlement token. */
  readonly railFee: TokenAmount;
  /** The leg's transaction, as a chain-agnostic receipt reference. */
  readonly receiptRef: ReceiptRef;
}

/** A wallet leg: the recipient received `amount` itself. */
export interface WalletReceiptLeg extends ReceiptLegBase {
  readonly method: WalletPayoutMethod;
  readonly received: null;
}

export interface LocalReceiptLeg extends ReceiptLegBase {
  readonly method: LocalPayoutMethod;
  /** The amount the anchor delivered in the recipient's own currency. */
  readonly received: Money;
}

export type ReceiptLeg = WalletReceiptLeg | LocalReceiptLeg;

export function isWalletLeg(leg: ReceiptLeg): leg is WalletReceiptLeg {
  return isWalletMethod(leg.method);
}

export interface ReceiptFee {
  /** The take, paid on chain next to the payout and never folded into a leg. */
  readonly amount: TokenAmount;
  readonly bps: number;
}

export interface FeeRefund {
  readonly amount: TokenAmount;
  /** The transfer that returned it. */
  readonly receiptRef: ReceiptRef;
}

export interface ReceiptRevisionRef {
  readonly receiptNumber: string;
  /** The hash of the document it replaces, so revisions form a chain nobody can rewrite. */
  readonly documentSha256: string;
}

export interface Receipt {
  readonly principalId: string;
  readonly projectId: string;
  readonly receiptNumber: string;
  readonly revision: number;
  readonly supersedes: ReceiptRevisionRef | null;
  /** UTC, millisecond precision, so the document has one spelling of it. */
  readonly issuedAt: string;
  readonly payoutId: string;
  readonly taskId: string | null;
  readonly mandate: { readonly id: string; readonly name: string };
  /** The recipient reference the mandate checked on chain. */
  readonly recipientRef: string;
  /** The network that settled every leg. */
  readonly network: NetworkId;
  /** The payout's own event on that network. */
  readonly receiptRef: ReceiptRef;
  /** What the principal asked to pay. */
  readonly requested: Money;
  /** What reached the legs; the legs add up to it exactly. */
  readonly total: TokenAmount;
  readonly fee: ReceiptFee;
  /** total plus fee, what left the mandate. */
  readonly charged: TokenAmount;
  readonly feeRefunds: readonly FeeRefund[];
  readonly legs: readonly ReceiptLeg[];
}

/** A leg as recorded. Which methods carry a local amount is checked when it is built. */
export interface ReceiptLegInput extends Omit<ReceiptLegBase, 'receiptRef'> {
  readonly method: PayoutMethod;
  readonly received: Money | null;
  readonly receiptRef: string;
}

export interface ReceiptInput extends Omit<
  Receipt,
  'charged' | 'receiptRef' | 'feeRefunds' | 'legs'
> {
  readonly receiptRef: string;
  readonly feeRefunds: readonly { readonly amount: TokenAmount; readonly receiptRef: string }[];
  readonly legs: readonly ReceiptLegInput[];
}

// Own data fields only, so a getter or a prototype cannot supply a value.
function ownData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * Rebuilds a money value through the core constructors, so a forged or
 * mis-decoded value never reaches a receipt. Fiat must sit at its minor
 * unit: a receipt shows what was paid, not a working precision.
 */
function rebuild(value: unknown): Money | TokenAmount | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const kind = ownData(value, 'kind');
  const amount = ownData(value, 'amount');
  const scale = ownData(value, 'scale');
  if (typeof amount !== 'bigint') return undefined;
  try {
    const built =
      kind === 'fiat'
        ? money(amount, ownData(value, 'currency') as FiatCurrencyCode)
        : kind === 'token'
          ? tokenAmount(
              amount,
              ownData(value, 'asset') as TokenAsset,
              ownData(value, 'chain') as Chain,
            )
          : undefined;
    return built?.scale === scale ? built : undefined;
  } catch (error) {
    if (error instanceof MoneyError) return undefined;
    throw error;
  }
}

const FiatField = z.unknown().transform((value, ctx): Money => {
  const built = rebuild(value);
  if (built?.kind === 'fiat') return built;
  ctx.addIssue({ code: 'custom', message: 'fiat money at its minor unit' });
  return z.NEVER;
});

const TokenField = z.unknown().transform((value, ctx): TokenAmount => {
  const built = rebuild(value);
  if (built?.kind === 'token') return built;
  ctx.addIssue({ code: 'custom', message: 'a settlement token amount' });
  return z.NEVER;
});

const RefField = z
  .string()
  .max(128)
  .transform((text, ctx) => {
    try {
      const parts = parseReceiptRef(text);
      return { ref: formatReceiptRef(parts), network: parts.network };
    } catch (error) {
      if (!(error instanceof InvalidInputError)) throw error;
      ctx.addIssue({ code: 'custom', message: 'a receipt reference' });
      return z.NEVER;
    }
  });

// Text that ends up in the hashed document must have one UTF-8 encoding.
const Text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => text.isWellFormed(), 'well formed text');

const Uuid = z.uuid();
const ReceiptNumber = z.string().regex(/^R-[0-9A-Z]{12}$/, 'a receipt number');
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex SHA-256 digest');
const Network = z.custom<NetworkId>(isNetworkId, 'a network ID');

const LegSchema = z.strictObject({
  index: z
    .number()
    .int()
    .min(0)
    .max(MAX_RECEIPT_LEGS - 1),
  method: z.enum([...WALLET_PAYOUT_METHODS, ...LOCAL_PAYOUT_METHODS]),
  destination: z.strictObject({
    masked: Text(32),
    tag: z.bigint().min(0n).max(U64_MAX).nullable(),
  }),
  amount: TokenField,
  received: FiatField.nullable(),
  railFee: TokenField,
  receiptRef: RefField,
});

const InputSchema = z.strictObject({
  principalId: Uuid,
  projectId: Uuid,
  receiptNumber: ReceiptNumber,
  revision: z.number().int().min(1),
  supersedes: z
    .strictObject({ receiptNumber: ReceiptNumber, documentSha256: Sha256Hex })
    .nullable(),
  issuedAt: z.iso.datetime({ precision: 3 }),
  payoutId: Uuid,
  taskId: Text(255).nullable(),
  mandate: z.strictObject({ id: Uuid, name: Text(100) }),
  recipientRef: Sha256Hex,
  network: Network,
  receiptRef: RefField,
  requested: FiatField,
  total: TokenField,
  fee: z.strictObject({
    amount: TokenField,
    bps: z.number().int().min(0).max(MAX_FEE_BPS),
  }),
  feeRefunds: z
    .array(z.strictObject({ amount: TokenField, receiptRef: RefField }))
    .max(MAX_RECEIPT_LEGS),
  legs: z.array(LegSchema).min(1).max(MAX_RECEIPT_LEGS),
});

type Parsed = z.output<typeof InputSchema>;
type Issue = (path: readonly (string | number)[], message: string) => void;

/**
 * The most fee the mandate contract lets through for `total` at `bps`,
 * computed the contract's overflow-free way, so a receipt can never show a
 * fee the chain would have refused.
 */
export function feeCap(total: bigint, bps: number): bigint {
  const rate = BigInt(bps);
  return (total / 10_000n) * rate + ((total % 10_000n) * rate) / 10_000n;
}

/**
 * Runs a money operation and turns a unit mismatch or an overflow into an
 * issue. Core refuses to combine two tokens or two chains, so every token
 * amount on a receipt is proved to be in the total's unit by combining it
 * with the total, and a second settlement token can never slip into one.
 */
function guarded(issue: Issue, path: readonly (string | number)[], run: () => void): void {
  try {
    run();
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    issue(path, 'amounts share the total unit and stay in range');
  }
}

function checkLegs(r: Parsed, issue: Issue): void {
  r.legs.forEach((leg, i) => {
    if (leg.index !== i) issue(['legs', i, 'index'], 'legs are numbered from 0 in order');
    if (leg.amount.amount <= 0n) issue(['legs', i, 'amount'], 'must be positive');
    if (leg.railFee.amount < 0n) issue(['legs', i, 'railFee'], 'must not be negative');
    guarded(issue, ['legs', i, 'railFee'], () => compare(leg.railFee, r.total));
    if (isWalletMethod(leg.method) !== (leg.received === null)) {
      issue(['legs', i, 'received'], 'local legs state the local amount, wallet legs do not');
    }
    if (leg.received !== null && leg.received.amount <= 0n) {
      issue(['legs', i, 'received'], 'must be positive');
    }
    if (leg.receiptRef.network !== r.network) {
      issue(['legs', i, 'receiptRef'], 'every leg settles on the receipt network');
    }
  });
  // An empty list is already reported by its length check, and has no unit to sum in.
  if (r.legs.length === 0) return;
  guarded(issue, ['legs'], () => {
    const legsTotal = sum(r.legs.map((leg) => leg.amount));
    if (compare(legsTotal, r.total) !== 0) issue(['legs'], 'legs add up to the total');
  });
}

function checkFee(r: Parsed, issue: Issue): void {
  if (r.fee.amount.amount < 0n) issue(['fee', 'amount'], 'must not be negative');
  if (r.fee.amount.amount > feeCap(r.total.amount, r.fee.bps)) {
    issue(['fee', 'amount'], 'above the cap for the rate');
  }
  guarded(issue, ['fee', 'amount'], () => add(r.total, r.fee.amount));
  r.feeRefunds.forEach((refund, i) => {
    if (refund.amount.amount <= 0n) issue(['feeRefunds', i, 'amount'], 'must be positive');
    if (refund.receiptRef.network !== r.network) {
      issue(['feeRefunds', i, 'receiptRef'], 'refunds settle on the receipt network');
    }
  });
  if (r.feeRefunds.length === 0) return;
  guarded(issue, ['feeRefunds'], () => {
    const refunded = sum(r.feeRefunds.map((refund) => refund.amount));
    if (compare(refunded, r.fee.amount) > 0)
      issue(['feeRefunds'], 'cannot refund more than the fee');
  });
}

function check(r: Parsed, ctx: z.RefinementCtx): void {
  const issue: Issue = (path, message) => {
    ctx.addIssue({ code: 'custom', path: [...path], message });
  };
  if ((r.revision === 1) !== (r.supersedes === null)) {
    issue(['supersedes'], 'a revision after the first supersedes one');
  }
  if (r.requested.amount <= 0n) issue(['requested'], 'must be positive');
  if (r.total.amount <= 0n) issue(['total'], 'must be positive');
  // One chain today, so the types say these always match. Read as plain
  // strings, the check still guards a token on another chain the moment the
  // settlement table gains one.
  const [networkChain, totalChain]: string[] = [chainOf(r.network), r.total.chain];
  if (networkChain !== totalChain) issue(['total'], 'settles on the receipt network');
  if (r.receiptRef.network !== r.network) issue(['receiptRef'], 'on the receipt network');
  checkLegs(r, issue);
  checkFee(r, issue);
}

const ReceiptSchema = InputSchema.superRefine(check);

// Path and code only: the values are destinations, names and amounts.
function issueText(issue: z.core.$ZodIssue): string {
  const path = issue.path.length === 0 ? '$' : issue.path.map(String).join('.');
  return issue.code === 'custom' ? `${path} (${issue.message})` : `${path} (${issue.code})`;
}

/**
 * Builds a receipt from a payout as the rest of the system recorded it.
 * Every money value is rebuilt through the core constructors and every rule
 * of the model is checked; a failure throws ReceiptInvalidError listing
 * every path that broke. The result is deeply frozen.
 */
export function buildReceipt(input: ReceiptInput): Receipt {
  const parsed = ReceiptSchema.safeParse(input);
  if (!parsed.success) throw new ReceiptInvalidError(parsed.error.issues.map(issueText));
  const r = parsed.data;
  return Object.freeze({
    principalId: r.principalId,
    projectId: r.projectId,
    receiptNumber: r.receiptNumber,
    revision: r.revision,
    supersedes: r.supersedes === null ? null : Object.freeze({ ...r.supersedes }),
    issuedAt: r.issuedAt,
    payoutId: r.payoutId,
    taskId: r.taskId,
    mandate: Object.freeze({ ...r.mandate }),
    recipientRef: r.recipientRef,
    network: r.network,
    receiptRef: r.receiptRef.ref,
    requested: r.requested,
    total: r.total,
    fee: Object.freeze({ amount: r.fee.amount, bps: r.fee.bps }),
    charged: add(r.total, r.fee.amount),
    feeRefunds: Object.freeze(
      r.feeRefunds.map((refund) =>
        Object.freeze({ amount: refund.amount, receiptRef: refund.receiptRef.ref }),
      ),
    ),
    legs: Object.freeze(
      r.legs.map(
        (leg) =>
          // The check above tied the method to the presence of a local amount.
          Object.freeze({
            index: leg.index,
            method: leg.method,
            destination: Object.freeze({ ...leg.destination }),
            amount: leg.amount,
            received: leg.received,
            railFee: leg.railFee,
            receiptRef: leg.receiptRef.ref,
          }) as ReceiptLeg,
      ),
    ),
  });
}
