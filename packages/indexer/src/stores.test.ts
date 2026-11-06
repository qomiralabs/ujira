// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which session each port runs in and how rows map. The repositories are stood in
// for here, because the database test harness belongs to the database package; the
// SQL, the keys and the policies are tested there against a real server.

import { randomUUID } from 'node:crypto';

import type { Bytes32, TenantScope } from '@ujira/chain-adapter';
import type { Database } from '@ujira/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbCursorStore, dbIntakeStore, dbMandateRegistry } from './stores.js';

const repo = vi.hoisted(() => ({
  read: vi.fn(),
  advance: vi.fn(),
  find: vi.fn(),
  byAddress: vi.fn(),
  registered: vi.fn(),
  register: vi.fn(),
  flag: vi.fn(),
  tenantOf: vi.fn(),
  moveInstance: vi.fn(),
  book: vi.fn(),
  chainOf: vi.fn(),
}));

vi.mock('@ujira/db', () => ({
  chainCursors: { read: repo.read, advance: repo.advance },
  mandateRegistry: { find: repo.find },
  mandateInstances: { byAddress: repo.byAddress },
  mandateEventStore: (_db: unknown, chainOf: (network: string) => string) => {
    repo.chainOf.mockImplementation(chainOf);
    return {
      registered: repo.registered,
      register: repo.register,
      flag: repo.flag,
      tenantOf: repo.tenantOf,
      moveInstance: repo.moveInstance,
      book: repo.book,
    };
  },
}));

const NETWORK = 'stellar:testnet' as const;
const TAG = `0x${'ab'.repeat(32)}`;
const OPTS = { correlationId: 'stores' };
const scope = { principalId: randomUUID(), projectId: randomUUID() } as TenantScope;

const row = {
  network: NETWORK,
  contractId: 'CMANDATE',
  factory: 'CFACTORY',
  tenantTag: TAG,
  flagged: false,
};
const registration = {
  network: NETWORK,
  contractId: 'CMANDATE',
  factory: 'CFACTORY',
  tenantTag: TAG as Bytes32,
  flagged: false,
};

interface Opened {
  readonly session: string;
  readonly detail: unknown;
}

function database() {
  const opened: Opened[] = [];
  const tx = { marker: 'tx' };
  const db = {
    unscoped: (work: (t: unknown) => Promise<unknown>, role?: string) => {
      opened.push({ session: 'unscoped', detail: role });
      return work(tx);
    },
    tenant: (context: unknown) => ({
      transaction: (work: (t: unknown) => Promise<unknown>) => {
        opened.push({ session: 'tenant', detail: context });
        return work(tx);
      },
    }),
  } as unknown as Database;
  return { db, opened, tx };
}

beforeEach(() => {
  for (const mock of Object.values(repo)) mock.mockReset();
});

describe('the cursor store', () => {
  it('reads and advances as the indexer, with no tenant', async () => {
    const { db, opened, tx } = database();
    const cursors = dbCursorStore(db);
    repo.read.mockResolvedValue('stellar:v1:ledger:5');
    expect(await cursors.read(NETWORK)).toBe('stellar:v1:ledger:5');
    await cursors.advance(NETWORK, 'stellar:v1:ledger:6');
    expect(repo.read).toHaveBeenCalledWith(tx, NETWORK);
    expect(repo.advance).toHaveBeenCalledWith(tx, NETWORK, 'stellar:v1:ledger:6');
    expect(opened).toEqual([
      { session: 'unscoped', detail: 'indexer' },
      { session: 'unscoped', detail: 'indexer' },
    ]);
  });
});

describe('the intake store', () => {
  it('names the chain from the network, never from an event', () => {
    const { db } = database();
    dbIntakeStore(db);
    expect(repo.chainOf('stellar:testnet')).toBe('stellar');
  });

  it('reads a registration, and null for a contract with none', async () => {
    const store = dbIntakeStore(database().db);
    repo.registered.mockResolvedValueOnce(row).mockResolvedValueOnce(null);
    expect(await store.registered(NETWORK, 'CMANDATE')).toEqual(registration);
    expect(await store.registered(NETWORK, 'COTHER')).toBeNull();
  });

  it('adds a registration and says whether this call added it', async () => {
    const store = dbIntakeStore(database().db);
    repo.register.mockResolvedValue(true);
    const added = {
      network: NETWORK,
      contractId: 'CMANDATE',
      factory: 'CFACTORY',
      tenantTag: TAG as Bytes32,
      txHash: 'cd'.repeat(32),
      eventIndex: 0n,
      ledger: 5n,
    };
    expect(await store.register(added)).toBe(true);
    expect(repo.register).toHaveBeenCalledWith(added);
  });

  it('moves an instance under the tenant intake resolved, and says whether it moved', async () => {
    const store = dbIntakeStore(database().db);
    repo.moveInstance.mockResolvedValue(true);
    const tenant = { scope, mandateInstanceId: 'instance-1' };
    expect(await store.moveInstance(tenant, 'created')).toBe(true);
    expect(repo.moveInstance).toHaveBeenCalledWith(tenant, 'created');
  });

  it('passes a flag through with its reason', async () => {
    const store = dbIntakeStore(database().db);
    await store.flag(NETWORK, 'CMANDATE', 'public_test_attester');
    expect(repo.flag).toHaveBeenCalledWith(NETWORK, 'CMANDATE', 'public_test_attester');
  });

  it('finds the tenant that claims a contract, and null when none has', async () => {
    const store = dbIntakeStore(database().db);
    const tenant = { scope, mandateInstanceId: randomUUID() };
    repo.tenantOf.mockResolvedValueOnce(tenant).mockResolvedValueOnce(null);
    expect(await store.tenantOf(NETWORK, 'CMANDATE')).toEqual(tenant);
    expect(await store.tenantOf(NETWORK, 'COTHER')).toBeNull();
  });

  it('books an event with its payout, and one that moves no payout', async () => {
    const store = dbIntakeStore(database().db);
    repo.book.mockResolvedValue(true);
    const booking = {
      tenant: { scope, mandateInstanceId: randomUUID() },
      network: NETWORK,
      contractId: 'CMANDATE',
      txHash: 'cd'.repeat(32),
      eventIndex: 1n,
      ledger: 7n,
      closedAt: '2026-11-04T00:00:00Z',
      name: 'payout_requested',
      payload: { total: '100' },
    };
    const payoutId = `0x${'ef'.repeat(32)}`;
    expect(await store.book({ ...booking, payoutId: payoutId as Bytes32 })).toBe(true);
    expect(repo.book).toHaveBeenLastCalledWith({ ...booking, payoutId });
    expect(await store.book({ ...booking, payoutId: null })).toBe(true);
    expect(repo.book).toHaveBeenLastCalledWith({ ...booking, payoutId: null });
  });
});

describe('the mandate registry', () => {
  it('reads a registration with no tenant, as the app', async () => {
    const { db, opened, tx } = database();
    const registry = dbMandateRegistry(db);
    repo.find.mockResolvedValueOnce(row).mockResolvedValueOnce(undefined);
    expect(await registry.registered(NETWORK, 'CMANDATE', OPTS)).toEqual(registration);
    expect(await registry.registered(NETWORK, 'COTHER', OPTS)).toBeNull();
    expect(repo.find).toHaveBeenCalledWith(tx, NETWORK, 'CMANDATE');
    expect(opened).toEqual([
      { session: 'unscoped', detail: undefined },
      { session: 'unscoped', detail: undefined },
    ]);
  });

  it('looks for a claim only inside the tenant asking', async () => {
    const { db, opened, tx } = database();
    const registry = dbMandateRegistry(db);
    repo.byAddress
      .mockResolvedValueOnce({ createdAt: new Date(1_793_500_000_999) })
      .mockResolvedValueOnce(undefined);
    expect(await registry.claimedAt(scope, NETWORK, 'CMANDATE', OPTS)).toBe(1_793_500_000n);
    expect(await registry.claimedAt(scope, NETWORK, 'COTHER', OPTS)).toBeNull();
    expect(repo.byAddress).toHaveBeenCalledWith(tx, 'stellar', 'CMANDATE');
    expect(opened).toEqual([
      { session: 'tenant', detail: scope },
      { session: 'tenant', detail: scope },
    ]);
  });
});
