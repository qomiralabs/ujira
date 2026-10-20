// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Closed lists. Each one is the whole set of values v1 can send; a new value
// is an additive API change and lands here first.

import { z } from 'zod';

export const PAYOUT_STATUSES = Object.freeze([
  'queued',
  'submitting',
  'pending_approval',
  'approved',
  'settling',
  'delivering',
  'partly_paid',
  'paid',
  'needs_attention',
  'blocked',
  'rejected',
  'cancelled',
  'failed',
] as const);
export const PayoutStatus = z.enum(PAYOUT_STATUSES);
export type PayoutStatus = z.infer<typeof PayoutStatus>;

/** Statuses a payout never leaves. */
export const TERMINAL_PAYOUT_STATUSES: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
  'paid',
  'blocked',
  'rejected',
  'cancelled',
  'failed',
]);

/** Statuses that mean the mandate's rules let the payout through. */
export const ALLOWED_PAYOUT_STATUSES: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
  'approved',
  'settling',
  'delivering',
  'partly_paid',
  'paid',
  'needs_attention',
]);

/** Why a queued payout is waiting, when it is waiting on something. */
export const QueuedReason = z.enum(['awaiting_funding', 'network_unavailable']);

export const PAYOUT_METHODS = Object.freeze([
  'stellar_wallet',
  'bank',
  'mobile_money',
  'cash_pickup',
] as const);
export const PayoutMethod = z.enum(PAYOUT_METHODS);
export type PayoutMethod = z.infer<typeof PayoutMethod>;

/** The methods paid out in local currency through an anchor. */
export const LocalPayoutMethod = z.enum(['bank', 'mobile_money', 'cash_pickup']);

/** Read only, for developer views of a leg. */
export const RAIL_IDS = Object.freeze(['stellar.wallet', 'stellar.sep31'] as const);
export const RailId = z.enum(RAIL_IDS);

export const ALLOWED_BY = Object.freeze([
  'allowlist_auto',
  'allowlist_approved',
  'attestation_auto',
  'attestation_approved',
  'allowlist_and_attestation_auto',
  'allowlist_and_attestation_approved',
] as const);
export const AllowedBy = z.enum(ALLOWED_BY);
export type AllowedBy = z.infer<typeof AllowedBy>;

/** The only reason spec version 1 can hold a payout for approval. */
export const ApprovalReason = z.enum(['above_threshold']);

export const MANDATE_STATUSES = Object.freeze([
  'draft',
  'active',
  'paused',
  'revoked',
  'expired',
] as const);
export const MandateStatus = z.enum(MANDATE_STATUSES);
export type MandateStatus = z.infer<typeof MandateStatus>;

export const MANDATE_INSTANCE_STATUSES = Object.freeze([
  'deploying',
  'active',
  'paused',
  'revoked',
  'expired',
  'deploy_failed',
] as const);
export const MandateInstanceStatus = z.enum(MANDATE_INSTANCE_STATUSES);
export type MandateInstanceStatus = z.infer<typeof MandateInstanceStatus>;

export const RECIPIENT_MODES = Object.freeze(['allowlist', 'attested', 'both'] as const);
export const RecipientMode = z.enum(RECIPIENT_MODES);
export type RecipientMode = z.infer<typeof RecipientMode>;

export const MANDATE_ROLES = Object.freeze([
  'agent',
  'approver',
  'guardian',
  'executor',
  'recovery',
] as const);
export const MandateRole = z.enum(MANDATE_ROLES);

export const LEG_STATUSES = Object.freeze([
  'planned',
  'submitted',
  'settled',
  'delivering',
  'delivered',
  'failed',
  'cancelled',
] as const);
export const LegStatus = z.enum(LEG_STATUSES);
export type LegStatus = z.infer<typeof LegStatus>;

export const DEPOSIT_STATUSES = Object.freeze(['seen', 'confirmed', 'reversed'] as const);
export const DepositStatus = z.enum(DEPOSIT_STATUSES);
export type DepositStatus = z.infer<typeof DepositStatus>;

export const CASHOUT_COST_BEARERS = Object.freeze(['recipient', 'principal'] as const);
export const CashoutCostBearer = z.enum(CASHOUT_COST_BEARERS);

/** The left to right steps of a payout, in the order they happen. */
export const TIMELINE_STEPS = Object.freeze([
  'requested',
  'approved',
  'quoted',
  'settled',
  'delivered',
] as const);
export const TimelineStep = z.enum(TIMELINE_STEPS);
