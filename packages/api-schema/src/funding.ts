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
import { LowBalanceState } from './low-balance.js';
import { TokenAmount, TokenAssetCode, tokenSumEquals } from './money.js';

/** total is everything the instance holds; available is free to commit. */
export const FundingBalance = z
  .strictObject({
    total: TokenAmount,
    available: TokenAmount,
    committed: TokenAmount,
  })
  .superRefine((value, ctx) => {
    if (!tokenSumEquals([value.available, value.committed], value.total)) {
      ctx.addIssue({
        code: 'custom',
        path: ['total'],
        message: 'available and committed must add up to total',
      });
    }
  });

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
