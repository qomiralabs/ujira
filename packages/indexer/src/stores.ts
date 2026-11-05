// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The ports of the chain adapter's event scan and mandate trust, over the database.
// The rows stay in the repositories: this only picks the session each port runs in
// and turns the database's strings into the adapter's branded types.

import {
  chainOf,
  type Bytes32,
  type CursorStore,
  type EventIntakeStore,
  type MandateRegistration,
  type MandateRegistry,
  type NetworkId,
  type TenantScope,
  type UnixSeconds,
} from '@ujira/chain-adapter';
import {
  chainCursors,
  mandateEventStore,
  mandateInstances,
  mandateRegistry,
  type Database,
  type MandateRegistryRow,
} from '@ujira/db';

type Hex = `0x${string}`;

function registrationOf(network: NetworkId, row: MandateRegistryRow): MandateRegistration {
  return {
    network,
    contractId: row.contractId,
    factory: row.factory,
    tenantTag: row.tenantTag as string as Bytes32,
    flagged: row.flagged,
  };
}

/** A position belongs to the chain's stream, so it runs with no tenant, as the indexer. */
export function dbCursorStore(db: Pick<Database, 'unscoped'>): CursorStore {
  return {
    read: (stream) => db.unscoped((tx) => chainCursors.read(tx, stream), 'worker'),
    advance: (stream, cursor) =>
      db.unscoped((tx) => chainCursors.advance(tx, stream, cursor), 'worker'),
  };
}

/** What event intake reads and writes, as the indexer's login. */
export function dbIntakeStore(db: Database): EventIntakeStore {
  const store = mandateEventStore(db, (network) => chainOf(network as NetworkId));
  return {
    async registered(network, contractId) {
      const row = await store.registered(network, contractId);
      return row === null ? null : registrationOf(network, row);
    },
    register: (registration) =>
      store.register({ ...registration, tenantTag: registration.tenantTag as string as Hex }),
    flag: (network, contractId, reason) => store.flag(network, contractId, reason),
    async tenantOf(network, contractId) {
      const tenant = await store.tenantOf(network, contractId);
      if (tenant === null) return null;
      return {
        scope: tenant.scope as TenantScope,
        mandateInstanceId: tenant.mandateInstanceId,
      };
    },
    book: (booking) =>
      store.book({
        ...booking,
        payoutId: booking.payoutId === null ? null : (booking.payoutId as string as Hex),
      }),
  };
}

/**
 * What mandate trust reads, as the app. Being claimed by a tenant is no reason to
 * trust a contract: its age only tells a mandate still waiting for its factory's
 * event from one that will never have one.
 */
export function dbMandateRegistry(db: Pick<Database, 'unscoped' | 'tenant'>): MandateRegistry {
  return {
    async registered(network, contractId) {
      const row = await db.unscoped((tx) => mandateRegistry.find(tx, network, contractId));
      return row === undefined ? null : registrationOf(network, row);
    },
    async claimedAt(scope, network, contractId) {
      const instance = await db
        .tenant(scope)
        .transaction((tx) => mandateInstances.byAddress(tx, chainOf(network), contractId));
      if (instance === undefined) return null;
      return BigInt(Math.floor(instance.createdAt.getTime() / 1000)) as UnixSeconds;
    },
  };
}
