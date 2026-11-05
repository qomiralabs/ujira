// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which session the sweep store opens and how it translates the table's refusals.
// The repository is stood in for here, because the database test harness belongs to
// the database package, whose tests pin the codes this relies on against a real
// server: 23505 for a second sweep of an operation and UJ004 for a refused move.

import { randomUUID } from 'node:crypto';

import type { Database, FundingSweep, NewFundingSweep } from '@ujira/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDbSweepStore } from './db-store.js';
import { SweepStateError } from './errors.js';

const repo = vi.hoisted(() => ({
  byDepositOperation: vi.fn(),
  create: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock('@ujira/db', () => ({
  fundingAccounts: {},
  mandateInstances: {},
  fundingSweeps: {
    byDepositOperation: repo.byDepositOperation,
    create: repo.create,
    setStatus: repo.setStatus,
  },
}));

const scope = { principalId: randomUUID(), projectId: randomUUID() };
const input = { depositOperationId: '42' } as NewFundingSweep;
const row = { id: randomUUID() } as FundingSweep;

function database(): { readonly db: Pick<Database, 'tenant'>; readonly opened: unknown[] } {
  const opened: unknown[] = [];
  const db = {
    tenant: (context: unknown) => ({
      transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        opened.push(context);
        return work('tx');
      },
    }),
  } as unknown as Pick<Database, 'tenant'>;
  return { db, opened };
}

function failing(code: string): Error {
  return Object.assign(new Error('refused'), { code });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('db-store.sweep.test.ts', () => {
  it('reads under the tenant it was given', async () => {
    const { db, opened } = database();
    repo.byDepositOperation.mockResolvedValue(row);
    const key = { chain: 'stellar', depositOperationId: '42' };
    expect(await createDbSweepStore(db).byDepositOperation(scope, key)).toBe(row);
    expect(opened).toEqual([scope]);
    expect(repo.byDepositOperation).toHaveBeenCalledWith('tx', key);
  });

  it('creates under the tenant it was given', async () => {
    const { db, opened } = database();
    repo.create.mockResolvedValue(row);
    expect(await createDbSweepStore(db).create(scope, input)).toBe(row);
    expect(opened).toEqual([scope]);
    expect(repo.create).toHaveBeenCalledWith('tx', input);
  });

  it('answers duplicate for an operation already recorded', async () => {
    const { db } = database();
    repo.create.mockRejectedValue(failing('23505'));
    expect(await createDbSweepStore(db).create(scope, input)).toBe('duplicate');
  });

  it('leaves any other failure to create as it was', async () => {
    const { db } = database();
    const other = failing('23503');
    repo.create.mockRejectedValue(other);
    await expect(createDbSweepStore(db).create(scope, input)).rejects.toBe(other);
  });

  it('moves under the tenant it was given, and says whether there was a row', async () => {
    const { db, opened } = database();
    repo.setStatus.mockResolvedValue(false);
    const move = { status: 'cancelled' } as const;
    expect(await createDbSweepStore(db).setStatus(scope, row.id, move)).toBe(false);
    expect(opened).toEqual([scope]);
    expect(repo.setStatus).toHaveBeenCalledWith('tx', row.id, move);
  });

  it('turns a move the table refuses into the state error the worker knows', async () => {
    const { db } = database();
    repo.setStatus.mockRejectedValue(failing('UJ004'));
    await expect(
      createDbSweepStore(db).setStatus(scope, row.id, { status: 'cancelled' }),
    ).rejects.toBeInstanceOf(SweepStateError);
  });

  it.each([
    ['a code it has no meaning for', failing('UJ006')],
    ['no code', 'not an error'],
  ])('leaves a failed move with %s as it was', async (_name, failure) => {
    const { db } = database();
    repo.setStatus.mockRejectedValue(failure);
    await expect(
      createDbSweepStore(db).setStatus(scope, row.id, { status: 'cancelled' }),
    ).rejects.toBe(failure);
  });
});
