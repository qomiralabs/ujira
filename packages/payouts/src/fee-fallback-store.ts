// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The zero fee fallback's records, over the database. The SQL and what holds it together
// are the database package's, tested there against a real server. What this adds is which
// session each call opens, and that the alert goes out in the transaction that raised the
// alarm: if the alert fails the alarm is not raised, so a retry tells operations, and the
// worst a crash can do is tell them twice.

import { feeAddressAlarms, feeFallback } from '@ujira/db';
import type { Database, PayoutAttempt } from '@ujira/db';
import type { NetworkId, PayRequest, PayoutId, ReceivabilityReason } from '@ujira/chain-adapter';

import { zeroFeeRequest } from './fee-fallback.js';
import type { FeeFallbackStore, ResendIdentity } from './fee-fallback.js';

interface StoreOptions {
  readonly signal: AbortSignal;
}

export interface FeeAddressAlerts {
  cannotReceive(network: NetworkId, reason: ReceivabilityReason, opts: StoreOptions): Promise<void>;
}

export interface FeeFallbackStoreOptions {
  readonly db: Pick<Database, 'tenant' | 'unscoped'>;
  /** When an attempt created now stops being able to land. */
  readonly attemptDeadline: () => Date;
  /** The on chain id of a payout's numbered attempt. */
  readonly chainIdFor: (payout: string, attemptNumber: number) => PayoutId;
  /** What the new attempt's request is sent under. */
  readonly identityOf: (failed: PayRequest, attempt: PayoutAttempt) => ResendIdentity;
  readonly alerts: FeeAddressAlerts;
}

/** The job named one payout and the on chain id belongs to another. Nothing was written. */
export class FeeResendPayoutMismatchError extends Error {
  override readonly name = 'FeeResendPayoutMismatchError';
  readonly code = 'FEE_RESEND_PAYOUT_MISMATCH';

  constructor() {
    super('The failed attempt does not belong to the payout named');
  }
}

export function createFeeFallbackStore(options: FeeFallbackStoreOptions): FeeFallbackStore {
  const { db, attemptDeadline, chainIdFor, identityOf, alerts } = options;
  return {
    async decideResend(scope, payoutId, opts) {
      opts.signal.throwIfAborted();
      await db.tenant(scope).transaction((tx) => feeFallback.decide(tx, payoutId));
    },

    async resendDecided(scope, payoutId, opts) {
      opts.signal.throwIfAborted();
      return db.tenant(scope).transaction((tx) => feeFallback.decided(tx, payoutId));
    },

    async resendWithoutFee(resend, opts) {
      opts.signal.throwIfAborted();
      const { failed, payout, unpaidFee, proof } = resend;
      const attempt = await db.tenant(resend.scope).transaction(async (tx) => {
        const made = await feeFallback.resend(tx, {
          failedOnChainId: failed.payoutId,
          proof: { ...proof },
          fee: unpaidFee,
          deadline: attemptDeadline(),
          chainIdFor: (attemptNumber) => chainIdFor(payout, attemptNumber),
        });
        // Thrown inside, so the attempt and the invoice item it just wrote are undone.
        if (made.attempt.payoutId !== payout) throw new FeeResendPayoutMismatchError();
        return made.attempt;
      });
      return zeroFeeRequest(failed, identityOf(failed, attempt));
    },

    async raiseAddressAlarm(network, reason, opts) {
      opts.signal.throwIfAborted();
      await db.unscoped(async (tx) => {
        if (await feeAddressAlarms.raise(tx, network, reason)) {
          await alerts.cannotReceive(network, reason, opts);
        }
      }, 'worker');
    },

    async clearAddressAlarm(network, opts) {
      opts.signal.throwIfAborted();
      await db.unscoped(async (tx) => feeAddressAlarms.clear(tx, network), 'worker');
    },
  };
}
