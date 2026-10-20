// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { z } from 'zod';

import {
  ChainAddress,
  CountryCode,
  DisplayName,
  NetworkId,
  Sha256Hex,
  Timestamp,
  Uuid,
  tenantFields,
} from './common.js';
import { pageQueryFields, listParam } from './envelope.js';
import { MandateInstanceStatus, MandateRole, MandateStatus, RecipientMode } from './enums.js';
import { LowBalance } from './low-balance.js';
import { Money, TokenAmount, TokenAssetCode, tokenSumEquals } from './money.js';

/**
 * Which countries a mandate pays into. The contract only ever sees the hash
 * of this list; the list itself stays off chain.
 */
export const CountryPolicy = z
  .strictObject({
    mode: z.enum(['allow', 'block']),
    countries: z.array(CountryCode).max(250),
  })
  .superRefine((value, ctx) => {
    const sorted = [...new Set(value.countries)].sort();
    if (sorted.join() !== value.countries.join()) {
      ctx.addIssue({
        code: 'custom',
        path: ['countries'],
        message: 'countries must be sorted and unique',
      });
    }
    if (value.mode === 'allow' && value.countries.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['countries'],
        message: 'an allow list cannot be empty',
      });
    }
  });
export type CountryPolicy = z.infer<typeof CountryPolicy>;

/** The four limits, in logical US dollars, shared by every instance. */
export const MandateLimits = z
  .strictObject({
    totalBudget: Money,
    perPaymentCap: Money,
    perRecipientDailyCap: Money,
    approvalThreshold: Money,
  })
  .superRefine((value, ctx) => {
    for (const [key, amount] of Object.entries(value)) {
      if (amount.currency !== 'USD') {
        ctx.addIssue({ code: 'custom', path: [key, 'currency'], message: 'limits are in USD' });
      }
    }
  });

/**
 * One instance's budget in its token. used is spent and never goes down;
 * pending is reserved by payouts waiting for approval and committed by
 * approved ones not yet executed; remaining is what a new payout may still
 * use. The four always add up to the total, which is what keeps a payout
 * from being requested beyond the budget.
 */
export const InstanceBudget = z
  .strictObject({
    total: TokenAmount,
    used: TokenAmount,
    pending: TokenAmount,
    committed: TokenAmount,
    remaining: TokenAmount,
  })
  .superRefine((value, ctx) => {
    if (
      !tokenSumEquals([value.used, value.pending, value.committed, value.remaining], value.total)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['total'],
        message: 'used, pending, committed and remaining must add up to total',
      });
    }
  });

const instanceSummaryFields = {
  id: Uuid,
  network: NetworkId,
  asset: TokenAssetCode,
  status: MandateInstanceStatus,
  budget: InstanceBudget,
} as const;

export const MandateInstanceSummary = z.strictObject(instanceSummaryFields);

export const MandateRoleMember = z.strictObject({
  role: MandateRole,
  address: ChainAddress,
  memberId: Uuid.nullable(),
});

export const MandateInstance = z
  .strictObject({
    ...instanceSummaryFields,
    specVersion: z.number().int().min(1),
    /** The contract address, which is also where deposits go. Null until deployed. */
    fundingAddress: ChainAddress.nullable(),
    roles: z.array(MandateRoleMember).max(100),
    approvalsRequired: z.number().int().min(0).max(10),
    maxFeeBps: z.number().int().min(0).max(100),
    payoutTtlSeconds: z.number().int().min(3600).max(2_592_000),
    policyEpoch: z.number().int().min(0),
    expiresAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    const deployed = !['deploying', 'deploy_failed'].includes(value.status);
    if (deployed && value.fundingAddress === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['fundingAddress'],
        message: 'a deployed instance has an address',
      });
    }
  });

const mandateFields = {
  ...tenantFields,
  id: Uuid,
  name: DisplayName,
  status: MandateStatus,
  recipientMode: RecipientMode,
  limits: MandateLimits,
  expiresAt: Timestamp,
  createdAt: Timestamp,
} as const;

export const MandateListItem = z.strictObject({
  ...mandateFields,
  instances: z.array(MandateInstanceSummary).max(16),
});
export type MandateListItem = z.infer<typeof MandateListItem>;

export const MandateDetail = z.strictObject({
  ...mandateFields,
  countryPolicy: CountryPolicy,
  countryPolicyHash: Sha256Hex,
  countryPolicyHashMatches: z.boolean(),
  lowBalance: LowBalance,
  instances: z.array(MandateInstance).max(16),
  updatedAt: Timestamp,
});
export type MandateDetail = z.infer<typeof MandateDetail>;

export const MandateListQuery = z.strictObject({
  ...pageQueryFields,
  status: listParam(MandateStatus).optional(),
});

export const MandateParams = z.strictObject({ id: Uuid });
