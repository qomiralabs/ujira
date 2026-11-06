// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Funds returned to a principal by a sweep of a closed mandate. A sweep is booked
// from its swept event, so it is booked once whoever sent it: UJIRA's return job,
// the principal, or anyone else after the grace. The event is stored once under its
// chain, transaction and index, and its journal once under the event, both by
// unique constraint, so a replay from a restarted indexer books nothing new.

import type { Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';
import { ledger } from './ledger.js';
import { chainEvents } from './mandates.js';

type Tx = Kysely<Schema>;

export interface SweptEventInput {
  readonly mandateInstanceId: string;
  readonly chain: string;
  readonly txHash: Buffer;
  readonly eventIndex: bigint;
  readonly ledger: bigint;
  /** Raw units of the instance's asset, as the event reports them. */
  readonly amount: bigint;
  readonly finalizedAt: Date;
}

/**
 * The event's key is already stored, but not where this tenant can see it. Booking it
 * here would put one sweep in two tenants' books, so it is refused instead.
 */
export class SweepBookingConflictError extends Error {
  override readonly name = 'SweepBookingConflictError';
  readonly code = 'SWEEP_BOOKING_CONFLICT';
  constructor() {
    super('this swept event is stored under another tenant');
  }
}

export const mandateReturns = {
  // Books one swept event in the current transaction: the money leaves the mandate's
  // balance for the outside. 'duplicate' when this event was booked before.
  book: async (db: Tx, input: SweptEventInput): Promise<'booked' | 'duplicate'> => {
    if (input.amount <= 0n) throw new RangeError('a sweep moves a positive amount');
    const event = await chainEvents.record(db, {
      mandateInstanceId: input.mandateInstanceId,
      chain: input.chain,
      txHash: input.txHash,
      eventIndex: input.eventIndex,
      ledger: input.ledger,
      eventType: 'swept',
      payload: { amount: input.amount.toString() },
      finalizedAt: input.finalizedAt,
    });
    if (event.id === undefined) throw new SweepBookingConflictError();
    const posted = await ledger.post(db, {
      mandateInstanceId: input.mandateInstanceId,
      chainEventId: event.id,
      entries: [
        { kind: 'balance', amount: -input.amount },
        { kind: 'external', amount: input.amount },
      ],
    });
    return posted.created ? 'booked' : 'duplicate';
  },
};
