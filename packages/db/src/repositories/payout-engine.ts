// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the payout advance job asks of the database beyond the payouts repository. As
// everywhere, nothing takes a tenant id, and every move is compare and set: false
// means another job got there first.

import type { TokenAmount } from '@ujira/core';
import { sql, type Kysely } from 'kysely';

import { amountParam } from '../money-mapper.js';
import type { Schema } from '../schema.generated.js';
import type { PayoutStatusValue } from './payouts.js';
import { assertTransition } from './payouts.js';

type Tx = Kysely<Schema>;

export interface InstanceOfMandate {
  readonly id: string;
  readonly chain: string;
  readonly contractAddress: string;
}

export const payoutEngine = {
  // What the on-chain payout id derives from. Undefined for another tenant's payout.
  idempotencyKey: async (tx: Tx, payoutId: string): Promise<string | undefined> => {
    const row = await tx
      .selectFrom('ujira.payouts')
      .select('idempotency_key')
      .where('id', '=', payoutId)
      .executeTakeFirst();
    return row?.idempotency_key;
  },

  // The token total, known once routed. Written once: a retry passes the same one.
  setTotal: async (tx: Tx, payoutId: string, total: TokenAmount): Promise<boolean> => {
    const result = await tx
      .updateTable('ujira.payouts')
      .set({
        total_amount: amountParam(total),
        total_asset: total.asset,
        total_chain: total.chain,
        total_scale: total.scale,
      })
      .where('id', '=', payoutId)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  },

  // Ends a payout with the reason it was refused or could not go on.
  end: async (
    tx: Tx,
    payoutId: string,
    move: {
      readonly from: PayoutStatusValue;
      readonly to: 'rejected' | 'failed';
      readonly code: string;
    },
  ): Promise<boolean> => {
    await assertTransition(tx, 'payout', move.from, move.to);
    const result = await tx
      .updateTable('ujira.payouts')
      .set({ status: move.to, status_reason: null, refusal_code: move.code })
      .where('id', '=', payoutId)
      .where('status', '=', move.from)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  },

  // No network can take it right now. It stays received and says why.
  markUnavailable: async (tx: Tx, payoutId: string): Promise<boolean> => {
    const result = await tx
      .updateTable('ujira.payouts')
      .set({ status_reason: 'network_unavailable' })
      .where('id', '=', payoutId)
      .where('status', '=', 'received')
      .where((where) =>
        where.or([
          where('status_reason', 'is', null),
          where('status_reason', '=', 'network_unavailable'),
        ]),
      )
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  },

  // A refusal the payout has not ended on, such as an execute that goes on to its own
  // retries. Kept so it can be seen while they run.
  noteRefusal: async (tx: Tx, payoutId: string, code: string): Promise<boolean> => {
    const result = await tx
      .updateTable('ujira.payouts')
      .set({ refusal_code: code })
      .where('id', '=', payoutId)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  },

  // Why a payout ended, if it did.
  refusalCode: async (tx: Tx, payoutId: string): Promise<string | undefined> => {
    const row = await tx
      .selectFrom('ujira.payouts')
      .select('refusal_code')
      .where('id', '=', payoutId)
      .executeTakeFirst();
    return row?.refusal_code ?? undefined;
  },

  instance: async (tx: Tx, id: string): Promise<InstanceOfMandate | undefined> => {
    const row = await tx
      .selectFrom('ujira.mandate_instances')
      .select(['id', 'chain', 'contract_address'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { id: row.id, chain: row.chain, contractAddress: row.contract_address };
  },

  instancesOfMandate: async (tx: Tx, mandateId: string): Promise<readonly InstanceOfMandate[]> => {
    const rows = await tx
      .selectFrom('ujira.mandate_instances')
      .select(['id', 'chain', 'contract_address'])
      .where('mandate_id', '=', mandateId)
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      chain: row.chain,
      contractAddress: row.contract_address,
    }));
  },

  // Raw units routed on this instance and not yet requested on chain, fee included.
  // The chain's free balance cannot show these yet, and counting them here is what
  // stops one balance being promised twice. An attempt of a payout that has ended
  // will never be requested, so it promises nothing.
  unrequestedOn: async (tx: Tx, mandateInstanceId: string): Promise<bigint> => {
    const result = await sql<{ total: string }>`
      select coalesce(sum(a.total_amount + a.fee_amount), 0)::text as total
        from ujira.payout_attempts as a
        join ujira.payouts as p
          on p.principal_id = a.principal_id
         and p.project_id = a.project_id
         and p.id = a.payout_id
       where a.mandate_instance_id = ${mandateInstanceId}::uuid
         and a.status = 'created'
         and p.status not in ('rejected', 'failed', 'cancelled', 'blocked')
    `.execute(tx);
    return BigInt(result.rows[0]?.total ?? '0');
  },
};

export const payoutEngineRepositories = { payoutEngine } as const;
