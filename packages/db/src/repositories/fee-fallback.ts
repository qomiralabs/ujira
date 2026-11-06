// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the zero fee fallback writes. No key UJIRA holds may cancel on chain, so a failed
// attempt is left to lapse: the decision to resend is recorded first, and once the chain
// proves the attempt dead, the new attempt and the one invoice item go in together. The
// two rows cannot part, so a payout can never carry an invoice with its fee also going
// out on chain, or a resend with its fee forgotten.

import { compare, type TokenAmount } from '@ujira/core';
import { sql, type Kysely } from 'kysely';

import { amountParam, tokenFromRow } from '../money-mapper.js';
import type { Schema } from '../schema.generated.js';
import { payoutAttempts, type AttemptStatusValue, type PayoutAttempt } from './payouts.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

/** No attempt of this tenant has that on chain id, or more than one does. */
export class FeeAttemptUnknownError extends Error {
  override readonly name = 'FeeAttemptUnknownError';
  readonly code = 'FEE_ATTEMPT_UNKNOWN';

  constructor() {
    super('No single payout attempt has that on chain id');
  }
}

/** A resend needs a recorded decision, so a lapse for any other reason is never paid again. */
export class FeeResendNotDecidedError extends Error {
  override readonly name = 'FeeResendNotDecidedError';
  readonly code = 'FEE_RESEND_NOT_DECIDED';

  constructor() {
    super('Nothing decided that this attempt is to be sent again without a fee');
  }
}

/** The attempt reached final, so the recipient is paid and nothing may go out again. */
export class FeeAttemptLandedError extends Error {
  override readonly name = 'FeeAttemptLandedError';
  readonly code = 'FEE_ATTEMPT_LANDED';

  constructor() {
    super('The attempt reached final, so it cannot be sent again');
  }
}

export interface UnpaidFeeItem {
  readonly id: string;
  readonly payoutId: string;
  readonly attemptId: string;
  readonly fee: TokenAmount;
  readonly createdAt: Date;
}

export interface NewFeeResend {
  readonly failedOnChainId: string;
  // Why the failed attempt can never land. Nothing frees a payout without it.
  readonly proof: Readonly<Record<string, unknown>>;
  // The fee the chain did not take, in the attempt's unit.
  readonly fee: TokenAmount;
  readonly deadline: Date;
  readonly chainIdFor: (attemptNumber: number) => string;
}

export interface FeeResend {
  readonly attempt: PayoutAttempt;
  // False on a rerun, which finds the attempt the first run made.
  readonly created: boolean;
}

const unpaidColumns = [
  'id',
  'payout_id',
  'attempt_id',
  'amount',
  'chain',
  'asset',
  'scale',
  'created_at',
] as const;

async function attemptIdOf(db: Tx, onChainId: string): Promise<string> {
  const rows = await db
    .selectFrom('ujira.payout_attempts')
    .select('id')
    .where('on_chain_payout_id', '=', onChainId)
    .limit(2)
    .execute();
  const [row] = rows;
  if (row === undefined || rows.length > 1) throw new FeeAttemptUnknownError();
  return row.id;
}

async function isDecided(db: Tx, attemptId: string): Promise<boolean> {
  const row = await db
    .selectFrom('ujira.fee_resend_decisions')
    .select('attempt_id')
    .where('attempt_id', '=', attemptId)
    .executeTakeFirst();
  return row !== undefined;
}

export const feeFallback = {
  // The same decision twice is one row, so a rerun of the job changes nothing.
  decide: async (db: Tx, onChainId: string): Promise<void> => {
    const attemptId = await attemptIdOf(db, onChainId);
    await db
      .insertInto('ujira.fee_resend_decisions')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        attempt_id: attemptId,
      })
      .onConflict((conflict) =>
        conflict.columns(['principal_id', 'project_id', 'attempt_id']).doNothing(),
      )
      .execute();
  },

  decided: async (db: Tx, onChainId: string): Promise<boolean> =>
    isDecided(db, await attemptIdOf(db, onChainId)),

  // The caller's transaction holds all of it: the old attempt dead, the new one created
  // and the invoice item written. Racing resends wait on the payout's row, and the rest
  // then find what the first one made.
  resend: async (db: Tx, input: NewFeeResend): Promise<FeeResend> => {
    const attemptId = await attemptIdOf(db, input.failedOnChainId);
    if (!(await isDecided(db, attemptId))) throw new FeeResendNotDecidedError();
    const before = await payoutAttempts.get(db, attemptId);
    if (before === undefined) throw new FeeAttemptUnknownError();
    // A fee in another unit than the attempt would be misread by every later sum.
    compare(input.fee, before.total);
    await db
      .selectFrom('ujira.payouts')
      .select('id')
      .where('id', '=', before.payoutId)
      .forUpdate()
      .executeTakeFirstOrThrow();

    // Read again under the lock, because it may have moved while this waited.
    const failed = await payoutAttempts.get(db, attemptId);
    if (failed === undefined) throw new FeeAttemptUnknownError();
    if (failed.status === 'final') throw new FeeAttemptLandedError();
    if (failed.status !== 'dead') {
      await payoutAttempts.markDead(db, failed.id, {
        from: failed.status as Exclude<AttemptStatusValue, 'dead' | 'final'>,
        proof: input.proof,
      });
    }

    const attempts = await payoutAttempts.forPayout(db, failed.payoutId);
    const later = attempts.find((a) => a.attemptNumber > failed.attemptNumber);
    if (later !== undefined) return { attempt: later, created: false };

    const attempt = await payoutAttempts.create(db, {
      payoutId: failed.payoutId,
      mandateInstanceId: failed.mandateInstanceId,
      network: failed.network,
      total: failed.total,
      deadline: input.deadline,
      onChainPayoutId: input.chainIdFor(failed.attemptNumber + 1),
    });
    // A payout that fails on its fee twice still owes one fee, so the first item stands.
    await db
      .insertInto('ujira.unpaid_fee_items')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        payout_id: failed.payoutId,
        attempt_id: failed.id,
        amount: amountParam(input.fee),
        chain: input.fee.chain,
        asset: input.fee.asset,
        scale: input.fee.scale,
      })
      .onConflict((conflict) =>
        conflict.columns(['principal_id', 'project_id', 'payout_id']).doNothing(),
      )
      .execute();
    return { attempt, created: true };
  },

  unpaidForPayout: async (db: Tx, payoutId: string): Promise<UnpaidFeeItem | undefined> => {
    const row = await db
      .selectFrom('ujira.unpaid_fee_items')
      .select(unpaidColumns)
      .where('payout_id', '=', payoutId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      payoutId: row.payout_id,
      attemptId: row.attempt_id,
      fee: tokenFromRow({
        amount: row.amount,
        asset: row.asset,
        chain: row.chain,
        scale: row.scale,
      }),
      createdAt: row.created_at,
    };
  },
};

export type FeeAddressAlarmReason =
  | 'ACCOUNT_NOT_FOUND'
  | 'DESTINATION_IS_ISSUER'
  | 'NO_TRUSTLINE'
  | 'TRUSTLINE_NOT_AUTHORIZED'
  | 'TRUSTLINE_LIMIT';

// UJIRA's own fee address, one per network and no tenant's, so these live in ops and are
// reached through the worker role's two functions.
export const feeAddressAlarms = {
  // True only for the call that raised it, so operations hear once until it is cleared.
  raise: async (db: Tx, network: string, reason: FeeAddressAlarmReason): Promise<boolean> => {
    const result = await sql<{ raised: boolean }>`
      select ops.raise_fee_address_alarm(${network}, ${reason}) as raised
    `.execute(db);
    return result.rows[0]?.raised === true;
  },

  clear: async (db: Tx, network: string): Promise<boolean> => {
    const result = await sql<{ cleared: boolean }>`
      select ops.clear_fee_address_alarm(${network}) as cleared
    `.execute(db);
    return result.rows[0]?.cleared === true;
  },
};

export const feeFallbackRepositories = { feeFallback };
