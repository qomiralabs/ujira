// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The low-balance warning, in one file: the mandate setting, its default and
// the state the funding page reports.

import { z } from 'zod';

import { Timestamp } from './common.js';
import { TokenAmount } from './money.js';

/**
 * Two rules, either of which warns. runwayDays compares the free balance
 * with recent daily spend; fixed compares it with a token amount, because
 * the free balance is itself a token balance. At least one is always on.
 */
export const LowBalance = z
  .strictObject({
    runwayDays: z.number().int().min(1).max(90).nullable(),
    fixed: TokenAmount.nullable(),
  })
  .refine((value) => value.runwayDays !== null || value.fixed !== null, 'at least one rule');
export type LowBalance = z.infer<typeof LowBalance>;

/** What a mandate gets until the principal changes it. */
export const DEFAULT_LOW_BALANCE = Object.freeze({ runwayDays: 7, fixed: null } as const);

export const LowBalanceTrigger = z.enum(['runway', 'fixed']);

/** The setting plus whether it is firing now, which rules fired, and since when. */
export const LowBalanceState = z
  .strictObject({
    runwayDays: z.number().int().min(1).max(90).nullable(),
    fixed: TokenAmount.nullable(),
    triggered: z.boolean(),
    firedBy: z.array(LowBalanceTrigger).max(2),
    since: Timestamp.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.runwayDays === null && value.fixed === null) {
      ctx.addIssue({ code: 'custom', message: 'at least one rule' });
    }
    if (new Set(value.firedBy).size !== value.firedBy.length) {
      ctx.addIssue({ code: 'custom', path: ['firedBy'], message: 'each rule at most once' });
    }
    if (value.firedBy.includes('runway') && value.runwayDays === null) {
      ctx.addIssue({ code: 'custom', path: ['firedBy'], message: 'the runway rule is off' });
    }
    if (value.firedBy.includes('fixed') && value.fixed === null) {
      ctx.addIssue({ code: 'custom', path: ['firedBy'], message: 'the fixed rule is off' });
    }
    if (value.triggered !== value.firedBy.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['triggered'],
        message: 'triggered exactly when a rule fired',
      });
    }
    if (value.triggered !== (value.since !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['since'],
        message: 'since is set exactly while triggered',
      });
    }
  });
export type LowBalanceState = z.infer<typeof LowBalanceState>;
