// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { createEventScan } from './event-scan.js';
import type { CursorStore, EventPage, EventSource } from './event-scan.js';
import { createEventIntake } from './intake.js';
import type { LedgerEvent } from './intake.js';
import type { NetworkId } from './networks.js';
import { MemoryEventIntakeStore } from './testing/event-intake-store.js';
import type { Bytes32, TenantScope, Uuid } from './types.js';

const NETWORK: NetworkId = 'stellar:testnet';
const OPTS = { correlationId: 'scan' };
const FACTORY = 'CFACTORY';
const MANDATE = 'CMANDATE';
const PAYOUT = `0x${'ab'.repeat(32)}` as Bytes32;
const SCOPE: TenantScope = {
  principalId: '00000000-0000-4000-8000-000000000001' as Uuid,
  projectId: '00000000-0000-4000-8000-000000000002' as Uuid,
};
const tagFor = (scope: TenantScope, contract: string) =>
  `0x${`${scope.projectId}${contract}`.length.toString(16).padStart(2, '0').repeat(32)}` as Bytes32;
const TAG = tagFor(SCOPE, MANDATE);

let txs = 0;
function event(over: Partial<LedgerEvent> = {}): LedgerEvent {
  txs += 1;
  return {
    network: NETWORK,
    contractId: MANDATE,
    type: 'contract',
    successful: true,
    txHash: txs.toString(16).padStart(64, '0'),
    eventIndex: 0n,
    ledger: 10n,
    closedAt: '2026-11-02T00:00:00Z',
    name: 'payout_requested',
    key: PAYOUT,
    fields: { total: '100' },
    ...over,
  };
}

const created = (over: Partial<LedgerEvent> = {}) =>
  event({
    contractId: FACTORY,
    name: 'mandate_created',
    key: TAG,
    fields: { mandate: MANDATE },
    ...over,
  });

function world(pages: readonly EventPage[]) {
  const store = new MemoryEventIntakeStore();
  const asked: (string | null)[] = [];
  const cursors = new Map<string, string>();
  const cursorStore: CursorStore = {
    read: (stream) => Promise.resolve(cursors.get(stream) ?? null),
    advance: (stream, cursor) => {
      cursors.set(stream, cursor);
      return Promise.resolve();
    },
  };
  const source: EventSource = {
    page: (cursor) => {
      asked.push(cursor);
      const found = pages[asked.length - 1];
      return found === undefined
        ? Promise.reject(new Error('no such page'))
        : Promise.resolve(found);
    },
  };
  const scan = createEventScan({
    network: NETWORK,
    source,
    cursors: cursorStore,
    pageSize: 100,
    intake: createEventIntake({
      network: NETWORK,
      store,
      trustedFactories: () => [FACTORY],
      tenantTagFor: tagFor,
    }),
  });
  return { store, asked, cursors, scan };
}

const page = (events: readonly LedgerEvent[], nextCursor = 'next'): EventPage => ({
  events,
  nextCursor,
  latestLedger: 200,
});

describe('a step of the scan', () => {
  it('registers from the factory and books the mandate on the same page, in ledger order', async () => {
    const w = world([page([created(), event()])]);
    w.store.claim(NETWORK, MANDATE, { scope: SCOPE, mandateInstanceId: 'instance-1' });
    expect(await w.scan.step(OPTS)).toMatchObject({
      events: 2,
      registered: 1,
      booked: 1,
      cursor: 'next',
    });
    expect((await w.store.registered(NETWORK, MANDATE))?.factory).toBe(FACTORY);
    expect(w.store.events).toHaveLength(1);
  });

  it('counts what it ignored, and books nothing from a look-alike', async () => {
    const w = world([
      page([
        event({ contractId: 'CLOOKALIKE' }),
        created({ contractId: 'CLOOKALIKE', fields: { mandate: 'CLOOKALIKE' } }),
        event({ successful: false }),
      ]),
    ]);
    const result = await w.scan.step(OPTS);
    expect(result.ignored).toEqual({
      unregistered: 1,
      creation_off_list: 1,
      failed_transaction: 1,
    });
    expect(result.booked).toBe(0);
    expect(w.store.registrations).toEqual([]);
    expect(w.store.events).toEqual([]);
  });

  it('flags a tag that differs, and counts it', async () => {
    const w = world([page([created({ key: `0x${'ff'.repeat(32)}` as Bytes32 })])]);
    w.store.claim(NETWORK, MANDATE, { scope: SCOPE, mandateInstanceId: 'instance-1' });
    expect(await w.scan.step(OPTS)).toMatchObject({ flagged: 1, registered: 0 });
  });

  it('replaying a range writes nothing new', async () => {
    const first = [created(), event()];
    const w = world([page(first), page(first)]);
    w.store.claim(NETWORK, MANDATE, { scope: SCOPE, mandateInstanceId: 'instance-1' });
    await w.scan.step(OPTS);
    const again = await w.scan.step(OPTS);
    expect(again).toMatchObject({ booked: 0, replayed: 1 });
    expect(w.store.events).toHaveLength(1);
    expect(w.store.registrations).toHaveLength(1);
  });

  it('restart resumes from the stored cursor', async () => {
    const w = world([page([], 'second'), page([], 'third')]);
    await w.scan.step(OPTS);
    await w.scan.step(OPTS);
    expect(w.asked).toEqual([null, 'second']);
    expect(w.cursors.get(NETWORK)).toBe('third');
  });

  it('leaves the cursor where it was when an event cannot be stored', async () => {
    const w = world([page([created()])]);
    w.store.register = () => Promise.reject(new Error('database down'));
    await expect(w.scan.step(OPTS)).rejects.toThrow('database down');
    expect(w.cursors.size).toBe(0);
  });

  it('leaves the cursor where it was when the node cannot be read', async () => {
    const w = world([]);
    await expect(w.scan.step(OPTS)).rejects.toThrow('no such page');
    expect(w.cursors.size).toBe(0);
  });
});

describe('a mandate UJIRA just created', () => {
  it('reads as awaiting until the scan registers it, and never after', async () => {
    const w = world([page([created()])]);
    w.store.claim(NETWORK, MANDATE, { scope: SCOPE, mandateInstanceId: 'instance-1' });
    expect(await w.store.awaiting(SCOPE, NETWORK, MANDATE)).toBe(true);
    const other = { ...SCOPE, projectId: '00000000-0000-4000-8000-000000000099' as Uuid };
    expect(await w.store.awaiting(other, NETWORK, MANDATE)).toBe(false);
    await w.scan.step(OPTS);
    expect(await w.store.awaiting(SCOPE, NETWORK, MANDATE)).toBe(false);
  });
});
