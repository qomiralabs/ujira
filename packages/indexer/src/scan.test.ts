// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The scan put together: the intake it is handed writes through the database store,
// and the cursor only moves once a page is decided.

import type { EventIntakeStore, LedgerEvent } from '@ujira/chain-adapter';
import type { Database } from '@ujira/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createIndexerScan } from './scan.js';

const repo = vi.hoisted(() => ({
  read: vi.fn(),
  advance: vi.fn(),
}));

vi.mock('@ujira/db', () => ({
  chainCursors: { read: repo.read, advance: repo.advance },
  mandateEventStore: () => ({}),
}));

const NETWORK = 'stellar:testnet' as const;
const OPTS = { correlationId: 'scan' };

const event = {
  network: NETWORK,
  contractId: 'CMANDATE',
  type: 'contract',
  successful: true,
  txHash: 'cd'.repeat(32),
  eventIndex: 0n,
  ledger: 7n,
  closedAt: '2026-11-04T00:00:00Z',
  name: null,
  key: null,
  fields: null,
} as LedgerEvent;

const db = {
  unscoped: (work: (tx: unknown) => Promise<unknown>) => work({}),
} as unknown as Database;

beforeEach(() => {
  repo.read.mockReset();
  repo.advance.mockReset();
});

describe('the indexer scan', () => {
  it('reads from the stored cursor, decides the page, then moves the cursor', async () => {
    repo.read.mockResolvedValue('stellar:v1:ledger:5');
    const page = vi.fn().mockResolvedValue({
      events: [event],
      nextCursor: 'stellar:v1:ledger:6',
      latestLedger: 8,
    });
    const order: string[] = [];
    repo.advance.mockImplementation(() => {
      order.push('advance');
      return Promise.resolve();
    });
    let store: EventIntakeStore | undefined;
    const scan = createIndexerScan({
      db,
      network: NETWORK,
      source: { page },
      intakeFor: (given) => {
        store = given;
        return {
          ingest: () => {
            order.push('ingest');
            return Promise.resolve({ action: 'ignored', reason: 'unregistered' });
          },
        };
      },
      pageSize: 50,
    });
    const result = await scan.step(OPTS);
    expect(store).toBeDefined();
    expect(page).toHaveBeenCalledWith('stellar:v1:ledger:5', 50, OPTS);
    expect(order).toEqual(['ingest', 'advance']);
    expect(result).toMatchObject({
      events: 1,
      cursor: 'stellar:v1:ledger:6',
      latestLedger: 8,
      ignored: { unregistered: 1 },
    });
  });

  it('leaves the cursor where it was when an event cannot be decided', async () => {
    repo.read.mockResolvedValue(null);
    const scan = createIndexerScan({
      db,
      network: NETWORK,
      source: {
        page: () =>
          Promise.resolve({ events: [event], nextCursor: 'stellar:v1:ledger:6', latestLedger: 8 }),
      },
      intakeFor: () => ({ ingest: () => Promise.reject(new Error('database gone')) }),
      pageSize: 50,
    });
    await expect(scan.step(OPTS)).rejects.toThrow('database gone');
    expect(repo.advance).not.toHaveBeenCalled();
  });
});
