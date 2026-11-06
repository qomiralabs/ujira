// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What a payout read shows: the payout with its recipient's country, its
// mandate's name and its live attempt, newest first. As everywhere, no method
// takes a tenant id; the transaction's tenant decides what can be seen.
//
// A page ends at a position, the last row's creation time to the microsecond and
// its id, so the next page starts exactly after it whatever was written since.

import { sql, type Expression, type Kysely, type SqlBool } from 'kysely';

import type { Schema } from '../schema.generated.js';
import { checkedLimit } from './page.js';
import { approvals, payoutLegs, type PayoutLeg } from './payout-legs.js';
import { toPayout, type Payout } from './payouts.js';

type Tx = Kysely<Schema>;

/** One unit a requested amount can be in, with the bounds already in that unit. */
export type PayoutAmountBound =
  | {
      readonly kind: 'fiat';
      readonly currency: string;
      readonly min?: bigint;
      readonly max?: bigint;
    }
  | {
      readonly kind: 'token';
      readonly asset: string;
      readonly chain: string;
      readonly min?: bigint;
      readonly max?: bigint;
    };

export interface PayoutListFilter {
  /** Public statuses, as the API names them. */
  readonly statuses?: readonly string[];
  /** The recipient's country. */
  readonly corridors?: readonly string[];
  readonly methods?: readonly string[];
  readonly mandateIds?: readonly string[];
  /** The network of the live attempt, so a payout not routed yet matches none. */
  readonly networks?: readonly string[];
  /** Any of these; the caller works out which units an amount can be in. */
  readonly amounts?: readonly PayoutAmountBound[];
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
}

/** Where a page ended. The time is text, so no microsecond is lost on the way. */
export interface PayoutPosition {
  readonly createdAt: string;
  readonly id: string;
}

export interface PayoutAttemptSummary {
  readonly id: string;
  readonly network: string;
  readonly status: string;
  readonly legCount: number;
  readonly firstMethod: string | null;
}

export interface PayoutListing {
  readonly payout: Payout;
  readonly position: PayoutPosition;
  readonly recipientCountry: string;
  readonly mandateName: string;
  /** The attempt that is not dead, if there is one. */
  readonly attempt: PayoutAttemptSummary | null;
}

export interface PayoutView extends PayoutListing {
  /** The legs of the live attempt, in order. */
  readonly legs: readonly PayoutLeg[];
  /** The rate the principal agreed for this mandate, when the mandate has terms. */
  readonly agreedFeeBps: number | null;
  /** Approvals given on the live attempt. */
  readonly approvalsGiven: number;
}

export interface PayoutListPage {
  readonly items: readonly PayoutListing[];
  readonly next: PayoutPosition | null;
}

const POSITION_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class PayoutPositionError extends Error {
  readonly code = 'PAYOUT_POSITION';

  constructor() {
    super('a page position is a microsecond UTC time and a payout id');
    this.name = 'PayoutPositionError';
  }
}

function listingQuery(db: Tx) {
  return (
    db
      .selectFrom('ujira.payouts as p')
      .innerJoin('ujira.recipients as r', (join) =>
        join
          .onRef('r.principal_id', '=', 'p.principal_id')
          .onRef('r.project_id', '=', 'p.project_id')
          .onRef('r.id', '=', 'p.recipient_id'),
      )
      .innerJoin('ujira.mandates as m', (join) =>
        join
          .onRef('m.principal_id', '=', 'p.principal_id')
          .onRef('m.project_id', '=', 'p.project_id')
          .onRef('m.id', '=', 'p.mandate_id'),
      )
      // At most one attempt is not dead, which a unique index holds.
      .leftJoin('ujira.payout_attempts as a', (join) =>
        join
          .onRef('a.principal_id', '=', 'p.principal_id')
          .onRef('a.project_id', '=', 'p.project_id')
          .onRef('a.payout_id', '=', 'p.id')
          .on('a.status', '<>', 'dead'),
      )
      .selectAll('p')
      .select((eb) => [
        'r.country as recipient_country',
        'm.name as mandate_name',
        'a.id as attempt_id',
        'a.network as attempt_network',
        'a.status as attempt_status',
        sql<string>`to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'position_time',
        ),
        eb
          .selectFrom('ujira.payout_legs as l')
          .select((inner) => inner.fn.countAll<string>().as('n'))
          .whereRef('l.attempt_id', '=', 'a.id')
          .as('leg_count'),
        eb
          .selectFrom('ujira.payout_legs as l')
          .select('l.method')
          .whereRef('l.attempt_id', '=', 'a.id')
          .orderBy('l.leg_index')
          .limit(1)
          .as('first_method'),
      ])
  );
}

type ListingRow = Awaited<ReturnType<ReturnType<typeof listingQuery>['executeTakeFirstOrThrow']>>;

function toListing(row: ListingRow): PayoutListing {
  const attempt =
    row.attempt_id === null || row.attempt_network === null || row.attempt_status === null
      ? null
      : {
          id: row.attempt_id,
          network: row.attempt_network,
          status: row.attempt_status,
          // A count of at most four legs, so this is exact.
          legCount: Number(row.leg_count ?? '0'),
          firstMethod: row.first_method ?? null,
        };
  return {
    payout: toPayout(row),
    position: { createdAt: row.position_time, id: row.id },
    recipientCountry: row.recipient_country,
    mandateName: row.mandate_name,
    attempt,
  };
}

function checkedPosition(position: PayoutPosition): PayoutPosition {
  if (!POSITION_TIME.test(position.createdAt) || !UUID.test(position.id)) {
    throw new PayoutPositionError();
  }
  return position;
}

export const payoutViews = {
  // Newest first. Every filter given must match; within one filter, any value.
  page: async (
    db: Tx,
    filter: PayoutListFilter,
    page: { readonly limit: number; readonly after?: PayoutPosition },
  ): Promise<PayoutListPage> => {
    const limit = checkedLimit(page.limit);
    const after = page.after === undefined ? undefined : checkedPosition(page.after);
    const rows = await listingQuery(db)
      .where((eb) => {
        const all: Expression<SqlBool>[] = [];
        if (filter.statuses !== undefined) {
          all.push(eb('p.public_status', 'in', [...filter.statuses]));
        }
        if (filter.corridors !== undefined) all.push(eb('r.country', 'in', [...filter.corridors]));
        if (filter.methods !== undefined) all.push(eb('p.method', 'in', [...filter.methods]));
        if (filter.mandateIds !== undefined) {
          all.push(eb('p.mandate_id', 'in', [...filter.mandateIds]));
        }
        if (filter.networks !== undefined) all.push(eb('a.network', 'in', [...filter.networks]));
        if (filter.createdFrom !== undefined) {
          all.push(eb('p.created_at', '>=', filter.createdFrom));
        }
        if (filter.createdTo !== undefined) all.push(eb('p.created_at', '<=', filter.createdTo));
        if (filter.amounts !== undefined) {
          all.push(
            eb.or(
              filter.amounts.map((bound) => {
                const each: Expression<SqlBool>[] =
                  bound.kind === 'fiat'
                    ? [eb('p.requested_currency', '=', bound.currency)]
                    : [
                        eb('p.requested_asset', '=', bound.asset),
                        eb('p.requested_chain', '=', bound.chain),
                      ];
                if (bound.min !== undefined) {
                  each.push(eb('p.requested_amount', '>=', bound.min.toString()));
                }
                if (bound.max !== undefined) {
                  each.push(eb('p.requested_amount', '<=', bound.max.toString()));
                }
                return eb.and(each);
              }),
            ),
          );
        }
        if (after !== undefined) {
          all.push(
            sql<SqlBool>`(p.created_at, p.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
          );
        }
        return eb.and(all);
      })
      .orderBy('p.created_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(toListing);
    const last = items.at(-1);
    return { items, next: rows.length > limit && last !== undefined ? last.position : null };
  },

  get: async (db: Tx, id: string): Promise<PayoutView | undefined> => {
    const row = await listingQuery(db).where('p.id', '=', id).executeTakeFirst();
    if (row === undefined) return undefined;
    const listing = toListing(row);
    const terms = await db
      .selectFrom('ujira.mandate_terms')
      .select('agreed_fee_bps')
      .where('mandate_id', '=', listing.payout.mandateId)
      .executeTakeFirst();
    const attemptId = listing.attempt?.id;
    const legs = attemptId === undefined ? [] : await payoutLegs.forAttempt(db, attemptId);
    const given =
      attemptId === undefined
        ? 0
        : (await approvals.forAttempt(db, attemptId)).filter(
            (approval) => approval.decision === 'approved',
          ).length;
    return {
      ...listing,
      legs,
      // Checked to be 0 to 100, so this is exact.
      agreedFeeBps: terms === undefined ? null : Number(terms.agreed_fee_bps),
      approvalsGiven: given,
    };
  },
};

export const payoutViewRepositories = { payoutViews } as const;
