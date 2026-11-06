// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Where the agent keys UJIRA holds are seated, as the chain says. A seat is the mirror
// of a mandate's role events, so a key added by the principal straight on the contract
// shows here as soon as its event is read, not only when UJIRA's own flow adds it.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';

type Tx = Kysely<Schema>;

export type SeatRecipientMode = 'allowlist' | 'attested' | 'both';

export interface ManagedAgentSeat {
  readonly mandateInstanceId: string;
  readonly address: string;
  // Null while the instance's mode is not known, which the signer refuses.
  readonly recipientMode: SeatRecipientMode | null;
}

export const managedAgents = {
  // Every mandate of this tenant where an address of this agent's keys holds the agent
  // role now. A retiring key still signs, so its seats still count.
  seats: async (db: Tx, agentId: string): Promise<readonly ManagedAgentSeat[]> => {
    const rows = await db
      .selectFrom('ujira.managed_signers as s')
      .innerJoin('ujira.mandate_instance_roles as r', (join) =>
        join
          .onRef('r.principal_id', '=', 's.principal_id')
          .onRef('r.project_id', '=', 's.project_id')
          .onRef('r.address', '=', 's.address'),
      )
      .innerJoin('ujira.mandate_instances as i', (join) =>
        join
          .onRef('i.principal_id', '=', 'r.principal_id')
          .onRef('i.project_id', '=', 'r.project_id')
          .onRef('i.id', '=', 'r.mandate_instance_id')
          .onRef('i.network', '=', 's.network'),
      )
      .select(['r.mandate_instance_id', 'r.address', 'i.recipient_mode'])
      .where('s.agent_id', '=', agentId)
      .where('s.status', 'in', ['active', 'retiring'])
      .where('r.role', '=', 'agent')
      .where('r.revoked_event_id', 'is', null)
      .orderBy('r.mandate_instance_id')
      .execute();
    return rows.map((row) => ({
      mandateInstanceId: row.mandate_instance_id,
      address: row.address,
      recipientMode: row.recipient_mode as SeatRecipientMode | null,
    }));
  },

  // Whether this tenant holds a key for the address, retired keys included: an address
  // UJIRA ever held the key to is never treated as the principal's own.
  isManaged: async (db: Tx, network: string, address: string): Promise<boolean> => {
    const row = await db
      .selectFrom('ujira.managed_signers')
      .select(sql<number>`1`.as('found'))
      .where('network', '=', network)
      .where('address', '=', address)
      .executeTakeFirst();
    return row !== undefined;
  },
};

export const managedAgentRepositories = { managedAgents };
