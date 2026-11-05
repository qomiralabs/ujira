// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which contracts count as mandates, and the one booking each payout of each
// gets. The registry belongs to no tenant, so it is reached inside db.unscoped()
// through its narrow functions: the app can only read it and the indexer's login
// is the only one that can add to it. A booking is a tenant's row, and a contract
// is part of its key.

import { sql, type Kysely } from 'kysely';

import type { Database, ProjectContext } from '../database.js';
import type { Schema } from '../schema.generated.js';
import { entryPoints } from './entry-points.js';
import { chainEvents } from './mandates.js';
import { checkedLimit, pageOf, type Page, type PageRequest } from './page.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export interface MandateRegistryRow {
  readonly network: string;
  readonly contractId: string;
  readonly factory: string;
  readonly tenantTag: `0x${string}`;
  readonly flagged: boolean;
}

export type MandateFlagReason = 'tenant_tag_mismatch' | 'public_test_attester';

export interface MandateAlert {
  readonly id: bigint;
  readonly network: string;
  readonly contractId: string;
  readonly reason: MandateFlagReason;
  readonly raisedAt: Date;
}

export interface NewMandateRegistration {
  readonly network: string;
  readonly contractId: string;
  readonly factory: string;
  readonly tenantTag: `0x${string}`;
  /** 64 hex digits, as the chain prints a transaction hash. */
  readonly txHash: string;
  readonly eventIndex: bigint;
  readonly ledger: bigint;
}

function bytesOf(hex: string): Buffer {
  return Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex');
}

export const mandateRegistry = {
  find: async (
    db: Tx,
    network: string,
    contractId: string,
  ): Promise<MandateRegistryRow | undefined> => {
    const result = await sql<{ factory_id: string; tenant_tag: Buffer; flagged: boolean }>`
      select factory_id, tenant_tag, flagged
        from ops.registered_mandate(${network}, ${contractId})
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      network,
      contractId,
      factory: row.factory_id,
      tenantTag: `0x${row.tenant_tag.toString('hex')}`,
      flagged: row.flagged,
    };
  },

  // True when this call added it. The same contract again changes nothing, so a
  // replayed event cannot move a registration to another factory or tag.
  register: async (db: Tx, input: NewMandateRegistration): Promise<boolean> => {
    const result = await sql<{ added: boolean }>`
      select ops.register_mandate(
        ${input.network}, ${input.contractId}, ${input.factory},
        ${bytesOf(input.tenantTag)}, ${bytesOf(input.txHash)},
        ${input.eventIndex.toString()}::bigint, ${input.ledger.toString()}::bigint
      ) as added
    `.execute(db);
    return result.rows[0]?.added === true;
  },

  // True when the contract is registered. Nothing lifts a flag. The function raises
  // the alert for its reason as well, so one cannot commit without the other.
  flag: async (
    db: Tx,
    network: string,
    contractId: string,
    reason: MandateFlagReason,
  ): Promise<boolean> => {
    const result = await sql<{ found: boolean }>`
      select ops.flag_mandate(${network}, ${contractId}, ${reason}) as found
    `.execute(db);
    return result.rows[0]?.found === true;
  },

  // Oldest first, from the last one a reader has handled. Zero reads from the start.
  alertsAfter: async (db: Tx, afterId: bigint, limit: number): Promise<readonly MandateAlert[]> => {
    const result = await sql<{
      id: string;
      network: string;
      contract_id: string;
      reason: MandateFlagReason;
      raised_at: Date;
    }>`
      select id, network, contract_id, reason, raised_at
        from ops.mandate_alerts_after(${afterId.toString()}::bigint, ${checkedLimit(limit)})
    `.execute(db);
    return result.rows.map((row) => ({
      id: BigInt(row.id),
      network: row.network,
      contractId: row.contract_id,
      reason: row.reason,
      raisedAt: row.raised_at,
    }));
  },
};

export interface PayoutBooking {
  readonly id: string;
  readonly mandateInstanceId: string;
  readonly chain: string;
  readonly contractAddress: string;
  readonly payoutId: Buffer;
  readonly lastEventId: string;
  readonly lastEventType: string;
}

export interface PayoutBookingEvent {
  readonly mandateInstanceId: string;
  readonly chain: string;
  readonly contractAddress: string;
  readonly payoutId: Buffer;
  readonly eventId: string;
  readonly eventType: string;
}

const bookingColumns = [
  'id',
  'mandate_instance_id',
  'chain',
  'contract_address',
  'payout_id',
  'last_event_id',
  'last_event_type',
] as const;

function toBooking(row: {
  id: string;
  mandate_instance_id: string;
  chain: string;
  contract_address: string;
  payout_id: Buffer;
  last_event_id: string;
  last_event_type: string;
}): PayoutBooking {
  return {
    id: row.id,
    mandateInstanceId: row.mandate_instance_id,
    chain: row.chain,
    contractAddress: row.contract_address,
    payoutId: row.payout_id,
    lastEventId: row.last_event_id,
    lastEventType: row.last_event_type,
  };
}

export const payoutBookings = {
  // The event of a payout: its first makes the booking, each later one moves it.
  // A contract other than the instance's is refused by its trigger (23503).
  apply: async (db: Tx, input: PayoutBookingEvent): Promise<PayoutBooking> => {
    const row = await db
      .insertInto('ujira.payout_bookings')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_instance_id: input.mandateInstanceId,
        chain: input.chain,
        contract_address: input.contractAddress,
        payout_id: input.payoutId,
        last_event_id: input.eventId,
        last_event_type: input.eventType,
      })
      .onConflict((conflict) =>
        conflict.constraint('payout_bookings_once').doUpdateSet({
          last_event_id: input.eventId,
          last_event_type: input.eventType,
        }),
      )
      .returning(bookingColumns)
      .executeTakeFirstOrThrow();
    return toBooking(row);
  },

  get: async (db: Tx, id: string): Promise<PayoutBooking | undefined> => {
    const row = await db
      .selectFrom('ujira.payout_bookings')
      .select(bookingColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toBooking(row);
  },

  list: async (
    db: Tx,
    mandateInstanceId: string,
    page: PageRequest,
  ): Promise<Page<PayoutBooking>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.payout_bookings')
      .select(bookingColumns)
      .where('mandate_instance_id', '=', mandateInstanceId)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toBooking), limit, (booking) => booking.id);
  },
};

export interface IntakeTenant {
  readonly scope: ProjectContext;
  readonly mandateInstanceId: string;
}

export interface IntakeBooking {
  readonly tenant: IntakeTenant;
  readonly network: string;
  readonly contractId: string;
  readonly txHash: string;
  readonly eventIndex: bigint;
  readonly ledger: bigint;
  readonly closedAt: string;
  readonly name: string;
  readonly payload: unknown;
  readonly payoutId: `0x${string}` | null;
}

/**
 * What event intake reads and writes, as the indexer's login. A contract belongs
 * to one chain, so the chain comes from its network and is never taken from an
 * event. The event and its payout's move share a transaction, and a replay of an
 * event moves nothing.
 */
export function mandateEventStore(db: Database, chainOf: (network: string) => string) {
  const worker = <T>(work: (tx: Tx) => Promise<T>): Promise<T> => db.unscoped(work, 'worker');
  return {
    registered: async (network: string, contractId: string) =>
      (await worker((tx) => mandateRegistry.find(tx, network, contractId))) ?? null,
    register: (registration: NewMandateRegistration) =>
      worker((tx) => mandateRegistry.register(tx, registration)),
    flag: async (network: string, contractId: string, reason: MandateFlagReason): Promise<void> => {
      await worker((tx) => mandateRegistry.flag(tx, network, contractId, reason));
    },
    tenantOf: async (network: string, contractId: string): Promise<IntakeTenant | null> => {
      const found = await worker((tx) =>
        entryPoints.resolveMandateInstance(tx, chainOf(network), contractId),
      );
      if (found === undefined) return null;
      return {
        scope: { principalId: found.principalId, projectId: found.projectId },
        mandateInstanceId: found.mandateInstanceId,
      };
    },
    book: (booking: IntakeBooking): Promise<boolean> =>
      db.withTenant('worker', { ...booking.tenant.scope, scope: 'project' }, async (tx) => {
        const chain = chainOf(booking.network);
        const event = await chainEvents.record(tx, {
          mandateInstanceId: booking.tenant.mandateInstanceId,
          chain,
          txHash: bytesOf(booking.txHash),
          eventIndex: booking.eventIndex,
          ledger: booking.ledger,
          eventType: booking.name,
          payload: booking.payload,
          finalizedAt: new Date(booking.closedAt),
        });
        if (event.created && event.id !== undefined && booking.payoutId !== null) {
          await payoutBookings.apply(tx, {
            mandateInstanceId: booking.tenant.mandateInstanceId,
            chain,
            contractAddress: booking.contractId,
            payoutId: bytesOf(booking.payoutId),
            eventId: event.id,
            eventType: booking.name,
          });
        }
        return event.created;
      }),
  };
}
