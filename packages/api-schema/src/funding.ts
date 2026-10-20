// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { z } from 'zod';

import {
  ChainAddress,
  DisplayName,
  NetworkId,
  Timestamp,
  TxHash,
  Uuid,
  tenantFields,
} from './common.js';
import { Cursor, LimitParam, Page } from './envelope.js';
import { DepositStatus, MandateInstanceStatus } from './enums.js';
import type { MandateInstanceStatus as MandateInstanceStatusValue } from './enums.js';
import { LowBalanceState } from './low-balance.js';
import { TokenAmount, TokenAssetCode } from './money.js';

/**
 * total is everything the instance holds. pending is held back for payouts
 * waiting for approval, committed for approved ones not yet executed, and
 * available is what a new payout can still draw on. available is derived
 * from the other three and the instance state, so the rule lives on the
 * account below, which knows that state.
 */
export const FundingBalance = z.strictObject({
  total: TokenAmount,
  available: TokenAmount,
  pending: TokenAmount,
  committed: TokenAmount,
});

/**
 * Whether an instance in this state still has its balance held back by the
 * payouts reserved against it. A revoked or expired instance can pay nothing
 * more, so its reservations stay on record without holding anything; every
 * other state, paused included, still reserves.
 *
 * Every status is written out rather than matched against a list, so adding
 * one will not compile until someone decides which way it goes. Reserving is
 * the answer that cannot overstate what is available, so a state that never
 * reaches this point still says true.
 */
export const RESERVES_BALANCE: Readonly<Record<MandateInstanceStatusValue, boolean>> =
  Object.freeze({
    deploying: true,
    active: true,
    paused: true,
    revoked: false,
    expired: false,
    deploy_failed: true,
  });

/**
 * The available balance as the mandate reports it: what is left after the
 * reservations, never below zero, because an underfunded instance can owe
 * more than it holds.
 */
export function availableBalance(
  total: bigint,
  pending: bigint,
  committed: bigint,
  status: MandateInstanceStatusValue,
): bigint {
  if (!RESERVES_BALANCE[status]) return total;
  const free = total - pending - committed;
  return free > 0n ? free : 0n;
}

export const FundingAccount = z
  .strictObject({
    mandateId: Uuid,
    mandateName: DisplayName,
    mandateInstanceId: Uuid,
    status: MandateInstanceStatus,
    network: NetworkId,
    asset: TokenAssetCode,
    fundingAddress: ChainAddress,
    balance: FundingBalance,
    lowBalance: LowBalanceState,
  })
  .superRefine((value, ctx) => {
    // One settlement asset today, so the network is the part that can differ.
    if (value.balance.total.network !== value.network) {
      ctx.addIssue({
        code: 'custom',
        path: ['balance'],
        message: 'balance is on the account network',
      });
    }
    const expected = availableBalance(
      BigInt(value.balance.total.amount),
      BigInt(value.balance.pending.amount),
      BigInt(value.balance.committed.amount),
      value.status,
    );
    if (BigInt(value.balance.available.amount) !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['balance', 'available'],
        message: 'available does not match the reservations and the instance state',
      });
    }
  });

export const Deposit = z
  .strictObject({
    ...tenantFields,
    id: Uuid,
    mandateInstanceId: Uuid,
    network: NetworkId,
    amount: TokenAmount,
    fromAddress: ChainAddress,
    txHash: TxHash,
    status: DepositStatus,
    seenAt: Timestamp,
    confirmedAt: Timestamp.nullable(),
    reversedAt: Timestamp.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.amount.amount === '0') {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'a deposit moves at least one unit',
      });
    }
    if (value.status === 'confirmed' && value.confirmedAt === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmedAt'],
        message: 'a confirmed deposit has its time',
      });
    }
    if ((value.status === 'reversed') !== (value.reversedAt !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reversedAt'],
        message: 'reversedAt is set exactly when reversed',
      });
    }
    if (value.status === 'seen' && value.confirmedAt !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmedAt'],
        message: 'a seen deposit is not confirmed yet',
      });
    }
  });
export type Deposit = z.infer<typeof Deposit>;

export const FundingOverview = z.strictObject({
  ...tenantFields,
  accounts: z.array(FundingAccount).max(500),
  /** The newest deposits first; follow the cursor for older ones. */
  deposits: Page(Deposit),
});
export type FundingOverview = z.infer<typeof FundingOverview>;

export const FundingQuery = z.strictObject({
  depositsLimit: LimitParam.optional(),
  depositsCursor: Cursor.optional(),
});
