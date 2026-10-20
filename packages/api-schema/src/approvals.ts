// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { z } from 'zod';

import { NetworkId, Timestamp, Uuid, tenantFields } from './common.js';
import { listParam, pageQueryFields } from './envelope.js';
import { ApprovalReason } from './enums.js';
import { Money, TokenAmount, tokenSumEquals } from './money.js';
import { ApprovalCount, MandateSummaryRef, RecipientSummary } from './payouts.js';

/**
 * One payout waiting for approvers. It restates what approving would spend
 * and what the mandate has left, so the decision needs no second screen.
 */
export const ApprovalItem = z
  .strictObject({
    ...tenantFields,
    payoutId: Uuid,
    attemptId: Uuid,
    mandate: MandateSummaryRef,
    mandateInstanceId: Uuid,
    recipient: RecipientSummary,
    requested: Money,
    settlement: TokenAmount,
    take: TokenAmount,
    charged: TokenAmount,
    network: NetworkId,
    approvalReason: ApprovalReason,
    approvalThreshold: Money,
    remainingBudget: TokenAmount,
    approvals: ApprovalCount,
    requestedAt: Timestamp,
    /** Approvals that land after this are void and the payout lapses. */
    expiresAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    if (!tokenSumEquals([value.settlement, value.take], value.charged)) {
      ctx.addIssue({
        code: 'custom',
        path: ['charged'],
        message: 'charged must equal settlement plus take',
      });
    }
    if (value.approvals.given >= value.approvals.required) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvals'],
        message: 'a waiting payout still needs an approval',
      });
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.requestedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expires after it was requested',
      });
    }
  });
export type ApprovalItem = z.infer<typeof ApprovalItem>;

/** Oldest first, so the payout waiting longest is always on top. */
export const ApprovalListQuery = z.strictObject({
  ...pageQueryFields,
  mandateId: listParam(Uuid).optional(),
});
