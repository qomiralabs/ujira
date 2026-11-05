// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What route selection and the funding hold release read and move. The two moves
// are compare and sets on the held state itself, not on the status alone: a payout
// received and waiting on a network is not held, and a release must not route it.

import type { TokenAmount } from '@ujira/core';
import { sql, type Kysely } from 'kysely';

import { amountParam, tokenFromRow } from '../money-mapper.js';
import type { Schema } from '../schema.generated.js';
import { PageRequestError } from './page.js';

type Tx = Kysely<Schema>;

const AWAITING_FUNDING = 'awaiting_funding';

// A release job's batch rather than a page for a client: a job has to read more than
// a page to keep up with a busy network, and it must still not read without limit.
const MAX_HELD_BATCH = 1000;

export interface HeldRow {
  readonly principalId: string;
  readonly projectId: string;
  readonly payoutId: string;
  readonly network: string;
  readonly mandateInstanceId: string;
  readonly needed: TokenAmount;
  readonly heldAt: Date;
}

export interface InstanceOfMandate {
  readonly id: string;
  readonly chain: string;
  readonly contractAddress: string;
  readonly specVersion: string;
}

export interface UsableMethod {
  readonly id: string;
  readonly method: string;
  readonly rail: string;
  readonly chain: string;
}

function heldBatch(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HELD_BATCH) {
    throw new PageRequestError(`limit must be a whole number from 1 to ${String(MAX_HELD_BATCH)}`);
  }
  return limit;
}

function totalColumns(total: TokenAmount) {
  return {
    total_amount: amountParam(total),
    total_asset: total.asset,
    total_chain: total.chain,
    total_scale: total.scale,
  };
}

export const routing = {
  // Oldest first across whatever the transaction's scope can see, which for a
  // release job is every project of the principal. With the project on each row,
  // because each release then opens a transaction under that project.
  heldOnNetwork: async (db: Tx, network: string, limit: number): Promise<readonly HeldRow[]> => {
    const rows = await db
      .selectFrom('ujira.payout_funding_holds')
      .select([
        'principal_id',
        'project_id',
        'payout_id',
        'network',
        'chain',
        'mandate_instance_id',
        'needed_amount',
        'asset',
        'scale',
        'held_at',
      ])
      .where('network', '=', network)
      .orderBy('held_at')
      .orderBy('payout_id')
      .limit(heldBatch(limit))
      .execute();
    return rows.map((row) => ({
      principalId: row.principal_id,
      projectId: row.project_id,
      payoutId: row.payout_id,
      network: row.network,
      mandateInstanceId: row.mandate_instance_id,
      needed: tokenFromRow({
        amount: row.needed_amount,
        asset: row.asset,
        chain: row.chain,
        scale: row.scale,
      }),
      heldAt: row.held_at,
    }));
  },

  // The total goes on the row with the hold, because a payout asked for in local
  // currency has no other record of the token amount a later release must charge.
  // False when the payout is not received, so nothing was changed.
  recordTotal: async (db: Tx, payoutId: string, total: TokenAmount): Promise<boolean> => {
    const moved = await db
      .updateTable('ujira.payouts')
      .set(totalColumns(total))
      .where('id', '=', payoutId)
      .where('status', '=', 'received')
      .executeTakeFirst();
    return moved.numUpdatedRows > 0n;
  },

  // Of any number of releases racing the same payout, the first holds the row lock
  // until it commits, and the rest then find it no longer held and match nothing.
  moveHeldToRouted: async (db: Tx, payoutId: string, total: TokenAmount): Promise<boolean> => {
    const moved = await db
      .updateTable('ujira.payouts')
      .set({ status: 'routed', status_reason: null, ...totalColumns(total) })
      .where('id', '=', payoutId)
      .where('status', '=', 'received')
      .where('status_reason', '=', AWAITING_FUNDING)
      .executeTakeFirst();
    return moved.numUpdatedRows > 0n;
  },

  moveHeldToExpired: async (db: Tx, payoutId: string): Promise<boolean> => {
    const moved = await db
      .updateTable('ujira.payouts')
      .set({ status: 'failed', status_reason: 'funding_hold_expired' })
      .where('id', '=', payoutId)
      .where('status', '=', 'received')
      .where('status_reason', '=', AWAITING_FUNDING)
      .executeTakeFirst();
    return moved.numUpdatedRows > 0n;
  },

  instancesOfMandate: async (db: Tx, mandateId: string): Promise<readonly InstanceOfMandate[]> => {
    const rows = await db
      .selectFrom('ujira.mandate_instances')
      .select(['id', 'chain', 'contract_address', 'spec_version'])
      .where('mandate_id', '=', mandateId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      chain: row.chain,
      contractAddress: row.contract_address,
      specVersion: row.spec_version,
    }));
  },

  // Attempts created but not yet requested on chain: promised, and invisible in the
  // chain's free balance. In raw units, since an instance holds one asset and scale.
  unrequestedOnInstance: async (db: Tx, mandateInstanceId: string): Promise<bigint> => {
    const row = await db
      .selectFrom('ujira.payout_attempts')
      .select(sql<string>`coalesce(sum(total_amount), 0)::text`.as('total'))
      .where('mandate_instance_id', '=', mandateInstanceId)
      .where('status', '=', 'created')
      .executeTakeFirstOrThrow();
    return BigInt(row.total);
  },

  // Active methods of an active recipient. A method exists only after its
  // destination was proven, so being active is what makes it usable here. Whether
  // the person may be paid at all is the identity check's question, not this one.
  usableMethods: async (db: Tx, recipientId: string): Promise<readonly UsableMethod[]> => {
    const rows = await db
      .selectFrom('ujira.payout_methods as m')
      .innerJoin('ujira.recipients as r', (join) =>
        join
          .onRef('r.principal_id', '=', 'm.principal_id')
          .onRef('r.project_id', '=', 'm.project_id')
          .onRef('r.id', '=', 'm.recipient_id'),
      )
      .select(['m.id', 'm.method', 'm.rail', 'm.chain'])
      .where('m.recipient_id', '=', recipientId)
      .where('m.status', '=', 'active')
      .where('r.status', '=', 'active')
      .orderBy('m.created_at')
      .orderBy('m.id')
      .execute();
    return rows;
  },
};

export const routingRepositories = { routing };
