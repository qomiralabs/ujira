// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Repository methods for mandates, their deployed instances, funding sources,
// finalized chain events, role mirrors and deposits. As with the tenant roots,
// none takes a tenant id: visibility comes from the policies, and a new row
// takes its tenant from the transaction's context on the server.
//
// The app writes mandates, instances and funding sources. The indexer writes
// the mirror of what happened on chain, chain events, roles and deposits. The
// grants enforce that split, whichever method is called.

import type { TokenAmount } from '@ujira/core';
import { sql, type Kysely } from 'kysely';

import { amountParam, tokenFromRow } from '../money-mapper.js';
import type { Schema } from '../schema.generated.js';
import { checkedLimit, pageOf, PageRequestError, type Page, type PageRequest } from './page.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export interface Mandate {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: Date;
}

const mandateColumns = ['id', 'project_id', 'name', 'created_at'] as const;

function toMandate(row: {
  id: string;
  project_id: string;
  name: string;
  created_at: Date;
}): Mandate {
  return { id: row.id, projectId: row.project_id, name: row.name, createdAt: row.created_at };
}

export const mandates = {
  list: async (db: Tx, page: PageRequest): Promise<Page<Mandate>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.mandates')
      .select(mandateColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toMandate), limit, (mandate) => mandate.id);
  },

  get: async (db: Tx, id: string): Promise<Mandate | undefined> => {
    const row = await db
      .selectFrom('ujira.mandates')
      .select(mandateColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toMandate(row);
  },

  // An id may be given, for a flow that needs to know it before the row exists.
  create: async (
    db: Tx,
    input: { readonly name: string; readonly id?: string },
  ): Promise<Mandate> => {
    const row = await db
      .insertInto('ujira.mandates')
      .values({
        ...(input.id === undefined ? {} : { id: input.id }),
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        name: input.name,
      })
      .returning(mandateColumns)
      .executeTakeFirstOrThrow();
    return toMandate(row);
  },

  rename: async (db: Tx, id: string, name: string): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.mandates')
      .set({ name })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

export interface MandateInstance {
  readonly id: string;
  readonly mandateId: string;
  readonly chain: string;
  readonly contractAddress: string;
  readonly specVersion: string;
  readonly asset: string;
  readonly scale: number;
  readonly createdAt: Date;
}

export interface NewMandateInstance {
  readonly mandateId: string;
  readonly chain: string;
  readonly contractAddress: string;
  readonly specVersion: string;
  readonly asset: string;
  readonly scale: number;
}

const instanceColumns = [
  'id',
  'mandate_id',
  'chain',
  'contract_address',
  'spec_version',
  'asset',
  'scale',
  'created_at',
] as const;

function toInstance(row: {
  id: string;
  mandate_id: string;
  chain: string;
  contract_address: string;
  spec_version: string;
  asset: string;
  scale: number;
  created_at: Date;
}): MandateInstance {
  return {
    id: row.id,
    mandateId: row.mandate_id,
    chain: row.chain,
    contractAddress: row.contract_address,
    specVersion: row.spec_version,
    asset: row.asset,
    scale: row.scale,
    createdAt: row.created_at,
  };
}

export const mandateInstances = {
  list: async (db: Tx, page: PageRequest): Promise<Page<MandateInstance>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.mandate_instances')
      .select(instanceColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toInstance), limit, (instance) => instance.id);
  },

  get: async (db: Tx, id: string): Promise<MandateInstance | undefined> => {
    const row = await db
      .selectFrom('ujira.mandate_instances')
      .select(instanceColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toInstance(row);
  },

  // A chain and asset the settlement tokens do not list, or the wrong scale,
  // is refused by the foreign key (23503).
  create: async (db: Tx, input: NewMandateInstance): Promise<MandateInstance> => {
    const row = await db
      .insertInto('ujira.mandate_instances')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_id: input.mandateId,
        chain: input.chain,
        contract_address: input.contractAddress,
        spec_version: input.specVersion,
        asset: input.asset,
        scale: input.scale,
      })
      .returning(instanceColumns)
      .executeTakeFirstOrThrow();
    return toInstance(row);
  },
};

export interface FundingSource {
  readonly id: string;
  readonly mandateInstanceId: string;
  readonly kind: string;
  readonly createdAt: Date;
}

const fundingColumns = ['id', 'mandate_instance_id', 'kind', 'created_at'] as const;

function toFunding(row: {
  id: string;
  mandate_instance_id: string;
  kind: string;
  created_at: Date;
}): FundingSource {
  return {
    id: row.id,
    mandateInstanceId: row.mandate_instance_id,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

export const fundingSources = {
  list: async (db: Tx, page: PageRequest): Promise<Page<FundingSource>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.funding_sources')
      .select(fundingColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toFunding), limit, (source) => source.id);
  },

  get: async (db: Tx, id: string): Promise<FundingSource | undefined> => {
    const row = await db
      .selectFrom('ujira.funding_sources')
      .select(fundingColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toFunding(row);
  },

  create: async (
    db: Tx,
    input: { readonly mandateInstanceId: string; readonly kind: 'stablecoin_deposit' },
  ): Promise<FundingSource> => {
    const row = await db
      .insertInto('ujira.funding_sources')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_instance_id: input.mandateInstanceId,
        kind: input.kind,
      })
      .returning(fundingColumns)
      .executeTakeFirstOrThrow();
    return toFunding(row);
  },
};

export interface ChainEvent {
  readonly id: string;
  readonly mandateInstanceId: string;
  readonly chain: string;
  readonly txHash: Buffer;
  readonly eventIndex: bigint;
  readonly ledger: bigint;
  readonly eventType: string;
  readonly payload: unknown;
  readonly finalizedAt: Date;
}

export interface NewChainEvent {
  readonly mandateInstanceId: string;
  readonly chain: string;
  readonly txHash: Buffer;
  readonly eventIndex: bigint;
  readonly ledger: bigint;
  readonly eventType: string;
  readonly payload: unknown;
  readonly finalizedAt: Date;
}

const eventColumns = [
  'id',
  'mandate_instance_id',
  'chain',
  'tx_hash',
  'event_index',
  'ledger',
  'event_type',
  'payload',
  'finalized_at',
] as const;

function toEvent(row: {
  id: string;
  mandate_instance_id: string;
  chain: string;
  tx_hash: Buffer;
  event_index: string;
  ledger: string;
  event_type: string;
  payload: unknown;
  finalized_at: Date;
}): ChainEvent {
  return {
    id: row.id,
    mandateInstanceId: row.mandate_instance_id,
    chain: row.chain,
    txHash: row.tx_hash,
    eventIndex: BigInt(row.event_index),
    ledger: BigInt(row.ledger),
    eventType: row.event_type,
    payload: row.payload,
    finalizedAt: row.finalized_at,
  };
}

// The key of a page of events: its ledger and event index, in chain order.
const EVENT_KEY = /^(\d{1,19}):(\d{1,19})$/;

export const chainEvents = {
  // Stores a finalized event once. The same chain, transaction and index
  // presented again, by a restarted indexer or a reorganization, changes
  // nothing: `created` is false and `id` is the row already stored.
  record: async (
    db: Tx,
    input: NewChainEvent,
  ): Promise<{ readonly created: boolean; readonly id: string | undefined }> => {
    const inserted = await db
      .insertInto('ujira.chain_events')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_instance_id: input.mandateInstanceId,
        chain: input.chain,
        tx_hash: input.txHash,
        event_index: input.eventIndex,
        ledger: input.ledger,
        event_type: input.eventType,
        // Sent as JSON text: pg would send an array as a Postgres array.
        payload: JSON.stringify(input.payload),
        finalized_at: input.finalizedAt,
      })
      .onConflict((conflict) => conflict.constraint('chain_events_once').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted !== undefined) return { created: true, id: inserted.id };
    const existing = await db
      .selectFrom('ujira.chain_events')
      .select('id')
      .where('chain', '=', input.chain)
      .where('tx_hash', '=', input.txHash)
      .where('event_index', '=', input.eventIndex.toString())
      .executeTakeFirst();
    return { created: false, id: existing?.id };
  },

  get: async (db: Tx, id: string): Promise<ChainEvent | undefined> => {
    const row = await db
      .selectFrom('ujira.chain_events')
      .select(eventColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toEvent(row);
  },

  // Events of one instance, in chain order.
  list: async (db: Tx, mandateInstanceId: string, page: PageRequest): Promise<Page<ChainEvent>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.chain_events')
      .select(eventColumns)
      .where('mandate_instance_id', '=', mandateInstanceId)
      .orderBy('ledger')
      .orderBy('event_index')
      .limit(limit + 1);
    if (page.after !== undefined) {
      const key = EVENT_KEY.exec(page.after);
      if (key === null) throw new PageRequestError('after is not a key this list returned');
      query = query.where(
        sql<boolean>`(ledger, event_index) > (${key[1]}::bigint, ${key[2]}::bigint)`,
      );
    }
    return pageOf(
      (await query.execute()).map(toEvent),
      limit,
      (event) => `${event.ledger.toString()}:${event.eventIndex.toString()}`,
    );
  },
};

export type MandateRole = 'agent' | 'approver' | 'guardian' | 'executor' | 'recovery';

export interface InstanceRole {
  readonly role: string;
  readonly address: string;
  readonly grantedEventId: string;
  readonly revokedEventId: string | null;
}

export interface RoleGrant {
  readonly mandateInstanceId: string;
  readonly role: MandateRole;
  readonly address: string;
  readonly eventId: string;
}

const roleColumns = ['role', 'address', 'granted_event_id', 'revoked_event_id'] as const;

function toRole(row: {
  role: string;
  address: string;
  granted_event_id: string;
  revoked_event_id: string | null;
}): InstanceRole {
  return {
    role: row.role,
    address: row.address,
    grantedEventId: row.granted_event_id,
    revokedEventId: row.revoked_event_id,
  };
}

const ROLE_KEY = /^([a-z]+):(.+)$/;

export const instanceRoles = {
  // Who holds or held each role on one instance. A row with a revoked event
  // no longer holds it.
  list: async (
    db: Tx,
    mandateInstanceId: string,
    page: PageRequest,
  ): Promise<Page<InstanceRole>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.mandate_instance_roles')
      .select(roleColumns)
      .where('mandate_instance_id', '=', mandateInstanceId)
      .orderBy('role')
      .orderBy('address')
      .limit(limit + 1);
    if (page.after !== undefined) {
      const key = ROLE_KEY.exec(page.after);
      if (key === null) throw new PageRequestError('after is not a key this list returned');
      query = query.where(sql<boolean>`(role, address) > (${key[1]}, ${key[2]})`);
    }
    return pageOf(
      (await query.execute()).map(toRole),
      limit,
      (held) => `${held.role}:${held.address}`,
    );
  },

  // A role granted again after a revocation holds it again.
  grant: async (db: Tx, input: RoleGrant): Promise<void> => {
    await db
      .insertInto('ujira.mandate_instance_roles')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_instance_id: input.mandateInstanceId,
        role: input.role,
        address: input.address,
        granted_event_id: input.eventId,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['principal_id', 'project_id', 'mandate_instance_id', 'role', 'address'])
          .doUpdateSet({ granted_event_id: input.eventId, revoked_event_id: null }),
      )
      .execute();
  },

  // True when the address held the role and no longer does.
  revoke: async (db: Tx, input: RoleGrant): Promise<boolean> => {
    const result = await db
      .updateTable('ujira.mandate_instance_roles')
      .set({ revoked_event_id: input.eventId })
      .where('mandate_instance_id', '=', input.mandateInstanceId)
      .where('role', '=', input.role)
      .where('address', '=', input.address)
      .where('revoked_event_id', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  },
};

export interface Deposit {
  readonly id: string;
  readonly mandateInstanceId: string;
  readonly fundingSourceId: string | null;
  readonly chainEventId: string;
  readonly amount: TokenAmount;
  readonly fromAddress: string;
  readonly createdAt: Date;
}

export interface NewDeposit {
  readonly mandateInstanceId: string;
  readonly fundingSourceId: string | null;
  readonly chainEventId: string;
  readonly amount: TokenAmount;
  readonly fromAddress: string;
}

const depositColumns = [
  'id',
  'mandate_instance_id',
  'funding_source_id',
  'chain_event_id',
  'amount',
  'asset',
  'chain',
  'scale',
  'from_address',
  'created_at',
] as const;

function toDeposit(row: {
  id: string;
  mandate_instance_id: string;
  funding_source_id: string | null;
  chain_event_id: string;
  amount: string;
  asset: string;
  chain: string;
  scale: number;
  from_address: string;
  created_at: Date;
}): Deposit {
  return {
    id: row.id,
    mandateInstanceId: row.mandate_instance_id,
    fundingSourceId: row.funding_source_id,
    chainEventId: row.chain_event_id,
    amount: tokenFromRow(row),
    fromAddress: row.from_address,
    createdAt: row.created_at,
  };
}

export const deposits = {
  // One finalized event is at most one deposit, so recording it again changes
  // nothing and `created` is false. An amount not in the instance's asset,
  // chain and scale is refused by the foreign key (23503).
  record: async (
    db: Tx,
    input: NewDeposit,
  ): Promise<{ readonly created: boolean; readonly id: string | undefined }> => {
    const inserted = await db
      .insertInto('ujira.deposits')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_instance_id: input.mandateInstanceId,
        funding_source_id: input.fundingSourceId,
        chain_event_id: input.chainEventId,
        amount: amountParam(input.amount),
        asset: input.amount.asset,
        chain: input.amount.chain,
        scale: input.amount.scale,
        from_address: input.fromAddress,
      })
      .onConflict((conflict) => conflict.constraint('deposits_per_event').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted !== undefined) return { created: true, id: inserted.id };
    const existing = await db
      .selectFrom('ujira.deposits')
      .select('id')
      .where('chain_event_id', '=', input.chainEventId)
      .executeTakeFirst();
    return { created: false, id: existing?.id };
  },

  get: async (db: Tx, id: string): Promise<Deposit | undefined> => {
    const row = await db
      .selectFrom('ujira.deposits')
      .select(depositColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toDeposit(row);
  },

  list: async (db: Tx, page: PageRequest): Promise<Page<Deposit>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.deposits')
      .select(depositColumns)
      .orderBy('id')
      .limit(limit + 1);
    if (page.after !== undefined) query = query.where('id', '>', page.after);
    return pageOf((await query.execute()).map(toDeposit), limit, (deposit) => deposit.id);
  },
};

export const mandateRepositories = {
  mandates,
  mandateInstances,
  fundingSources,
  chainEvents,
  instanceRoles,
  deposits,
} as const;
