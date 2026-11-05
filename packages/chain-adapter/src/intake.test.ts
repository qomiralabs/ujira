// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { createEventIntake } from './intake.js';
import type { EventBooking, LedgerEvent } from './intake.js';
import type { NetworkId } from './networks.js';
import { MemoryEventIntakeStore } from './testing/event-intake-store.js';
import type { Bytes32, TenantScope, Uuid } from './types.js';

const NETWORK: NetworkId = 'stellar:testnet';
const FACTORY = 'CFACTORY';
const MANDATE = 'CMANDATE';
const SECOND = 'CSECOND';
const LOOKALIKE = 'CLOOKALIKE';
const PAYOUT = `0x${'ab'.repeat(32)}` as Bytes32;

const SCOPE: TenantScope = {
  principalId: '00000000-0000-4000-8000-000000000001' as Uuid,
  projectId: '00000000-0000-4000-8000-000000000002' as Uuid,
};
const TENANT = { scope: SCOPE, mandateInstanceId: 'instance-1' };

// A tag that depends on the tenant and the address, as the real one does.
function tagFor(scope: TenantScope, contract: string): Bytes32 {
  const seed = `${scope.projectId}${contract}`.length.toString(16).padStart(2, '0');
  return `0x${seed.repeat(32)}` as Bytes32;
}
const TAG = tagFor(SCOPE, MANDATE);
const WRONG_TAG = `0x${'ff'.repeat(32)}` as Bytes32;

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

function created(mandate: string, over: Partial<LedgerEvent> = {}): LedgerEvent {
  return event({
    contractId: FACTORY,
    name: 'mandate_created',
    key: tagFor(SCOPE, mandate),
    fields: { mandate, principal: 'GPRINCIPAL', asset: 'CUSDC' },
    ...over,
  });
}

function world(trusted: readonly string[] = [FACTORY]) {
  const store = new MemoryEventIntakeStore();
  let factories = trusted;
  const intake = createEventIntake({
    network: NETWORK,
    store,
    trustedFactories: () => factories,
    tenantTagFor: tagFor,
  });
  return {
    store,
    intake,
    distrust: () => {
      factories = [];
    },
  };
}

async function registered() {
  const w = world();
  w.store.claim(NETWORK, MANDATE, TENANT);
  await w.intake.ingest(created(MANDATE));
  return w;
}

describe('registration', () => {
  it('a mandate_created from a trusted factory registers the mandate it names', async () => {
    const w = world();
    expect(await w.intake.ingest(created(MANDATE))).toEqual({
      action: 'registered',
      contractId: MANDATE,
      created: true,
    });
    expect(await w.store.registered(NETWORK, MANDATE)).toEqual({
      network: NETWORK,
      contractId: MANDATE,
      factory: FACTORY,
      tenantTag: TAG,
      flagged: false,
    });
  });

  it('reading the same event again registers nothing new', async () => {
    const w = world();
    const first = created(MANDATE);
    await w.intake.ingest(first);
    expect(await w.intake.ingest(first)).toMatchObject({ created: false });
    expect(w.store.registrations).toHaveLength(1);
  });

  it('a mandate_created from a contract off the trusted list registers nothing', async () => {
    const w = world();
    expect(await w.intake.ingest(created(LOOKALIKE, { contractId: LOOKALIKE }))).toEqual({
      action: 'ignored',
      reason: 'creation_off_list',
    });
    expect(w.store.registrations).toEqual([]);
  });

  it('a registered mandate cannot vouch for another with its own mandate_created', async () => {
    const w = await registered();
    expect(await w.intake.ingest(created(LOOKALIKE, { contractId: MANDATE }))).toEqual({
      action: 'ignored',
      reason: 'creation_off_list',
    });
    expect(await w.store.registered(NETWORK, LOOKALIKE)).toBeNull();
  });

  it('a factory address in the data proves nothing', async () => {
    const w = world();
    await w.intake.ingest(
      created(LOOKALIKE, {
        contractId: LOOKALIKE,
        fields: { mandate: LOOKALIKE, factory: FACTORY, source: FACTORY },
      }),
    );
    expect(w.store.registrations).toEqual([]);
  });

  it('a trusted factory registers nothing with any other event', async () => {
    const w = world();
    expect(await w.intake.ingest(event({ contractId: FACTORY }))).toEqual({
      action: 'ignored',
      reason: 'not_a_creation',
    });
    expect(w.store.registrations).toEqual([]);
  });

  it('a creation with no mandate or no tag registers nothing', async () => {
    const w = world();
    for (const bad of [
      created(MANDATE, { key: null }),
      created(MANDATE, { fields: null }),
      created(MANDATE, { fields: { mandate: ['CMANDATE'] } }),
    ]) {
      expect(await w.intake.ingest(bad)).toEqual({ action: 'ignored', reason: 'malformed' });
    }
    expect(w.store.registrations).toEqual([]);
  });

  it('a directly deployed mandate with the reviewed wasm is never registered', async () => {
    const w = world();
    // It emits its own mandate_initialized, the one event a direct deploy gets.
    const init = event({ contractId: LOOKALIKE, name: 'mandate_initialized', key: TAG });
    expect(await w.intake.ingest(init)).toEqual({ action: 'ignored', reason: 'unregistered' });
    expect(await w.store.registered(NETWORK, LOOKALIKE)).toBeNull();
    expect(w.store.events).toEqual([]);
  });
});

describe('what counts as an event', () => {
  it('an event from a failed transaction books and registers nothing', async () => {
    const w = await registered();
    expect(await w.intake.ingest(event({ successful: false }))).toEqual({
      action: 'ignored',
      reason: 'failed_transaction',
    });
    expect(await w.intake.ingest(created(SECOND, { successful: false }))).toEqual({
      action: 'ignored',
      reason: 'failed_transaction',
    });
    expect(w.store.events).toEqual([]);
    expect(await w.store.registered(NETWORK, SECOND)).toBeNull();
  });

  it.each(['diagnostic', 'system'])('a %s event counts for nothing', async (type) => {
    const w = await registered();
    expect(await w.intake.ingest(event({ type }))).toEqual({
      action: 'ignored',
      reason: 'not_a_contract_event',
    });
    expect(await w.intake.ingest(created(SECOND, { type }))).toEqual({
      action: 'ignored',
      reason: 'not_a_contract_event',
    });
    expect(w.store.events).toEqual([]);
  });

  it('an event from another network counts for nothing', async () => {
    const w = await registered();
    expect(await w.intake.ingest(event({ network: 'stellar:pubnet' }))).toEqual({
      action: 'ignored',
      reason: 'wrong_network',
    });
  });

  it('a contract that copies the event shapes books nothing, whatever it names', async () => {
    const w = await registered();
    const copy = event({
      contractId: LOOKALIKE,
      // Everything an event can claim points at the real mandate.
      fields: { mandate: MANDATE, contract_id: MANDATE, tenant_tag: TAG, total: '1000000' },
    });
    expect(await w.intake.ingest(copy)).toEqual({ action: 'ignored', reason: 'unregistered' });
    expect(w.store.events).toEqual([]);
  });

  it('an event in no known shape books nothing, from anyone', async () => {
    const w = await registered();
    const unknown = { name: null, key: null, fields: null };
    expect(await w.intake.ingest(event(unknown))).toEqual({
      action: 'ignored',
      reason: 'malformed',
    });
    expect(await w.intake.ingest(event({ ...unknown, contractId: LOOKALIKE }))).toEqual({
      action: 'ignored',
      reason: 'unregistered',
    });
    expect(await w.intake.ingest(event({ key: null }))).toEqual({
      action: 'ignored',
      reason: 'malformed',
    });
    expect(await w.intake.ingest(event({ fields: null }))).toEqual({
      action: 'ignored',
      reason: 'malformed',
    });
    expect(w.store.events).toEqual([]);
  });
});

describe('booking', () => {
  it('books a registered mandate to its tenant, with the key under its own name', async () => {
    const w = await registered();
    expect(await w.intake.ingest(event())).toEqual({ action: 'booked', created: true });
    expect(w.store.events[0]).toMatchObject<Partial<EventBooking>>({
      tenant: TENANT,
      contractId: MANDATE,
      name: 'payout_requested',
      payoutId: PAYOUT,
      payload: { total: '100', payout_id: PAYOUT },
    });
    await w.intake.ingest(event({ name: 'paused', key: TAG, fields: { by: 'GGUARD' } }));
    expect(w.store.events[1]).toMatchObject<Partial<EventBooking>>({
      payoutId: null,
      payload: { by: 'GGUARD', tenant_tag: TAG },
    });
  });

  it('keeps a refused batch item on record without making it a payout', async () => {
    const w = await registered();
    await w.intake.ingest(event({ name: 'payout_request_rejected', fields: { code: '4' } }));
    expect(w.store.events[0]).toMatchObject<Partial<EventBooking>>({
      payoutId: null,
      payload: { code: '4', payout_id: PAYOUT },
    });
    expect(w.store.payouts.size).toBe(0);
  });

  it('replaying an event changes nothing', async () => {
    const w = await registered();
    const once = event();
    await w.intake.ingest(once);
    expect(await w.intake.ingest(once)).toEqual({ action: 'booked', created: false });
    expect(w.store.events).toHaveLength(1);
  });

  it('two mandates with an equal payout_id book as two payments', async () => {
    const w = await registered();
    w.store.claim(NETWORK, SECOND, { ...TENANT, mandateInstanceId: 'instance-2' });
    await w.intake.ingest(created(SECOND));
    await w.intake.ingest(event());
    await w.intake.ingest(event({ contractId: SECOND }));
    expect(w.store.payouts.size).toBe(2);
    expect(w.store.events.map((e) => e.contractId)).toEqual([MANDATE, SECOND]);
  });

  it('every event of one payout lands on one booking', async () => {
    const w = await registered();
    await w.intake.ingest(event());
    await w.intake.ingest(event({ name: 'payout_executed' }));
    expect(w.store.payouts.size).toBe(1);
    expect([...w.store.payouts.values()][0]?.map((e) => e.name)).toEqual([
      'payout_requested',
      'payout_executed',
    ]);
  });

  it('a mandate no tenant claims books nothing until one does', async () => {
    const w = world();
    await w.intake.ingest(created(MANDATE));
    expect(await w.intake.ingest(event())).toEqual({ action: 'ignored', reason: 'unattributed' });
    expect(w.store.events).toEqual([]);
    w.store.claim(NETWORK, MANDATE, TENANT);
    expect(await w.intake.ingest(event())).toEqual({ action: 'booked', created: true });
  });

  it('stops booking when the factory leaves the trusted list', async () => {
    const w = await registered();
    w.distrust();
    expect(await w.intake.ingest(event())).toEqual({
      action: 'ignored',
      reason: 'factory_off_list',
    });
    expect(w.store.events).toEqual([]);
  });
});

describe('a tag mismatch', () => {
  it('flags the mandate at registration and books nothing to a tenant', async () => {
    const w = world();
    w.store.claim(NETWORK, MANDATE, TENANT);
    expect(await w.intake.ingest(created(MANDATE, { key: WRONG_TAG }))).toEqual({
      action: 'flagged',
      contractId: MANDATE,
    });
    expect((await w.store.registered(NETWORK, MANDATE))?.flagged).toBe(true);
    expect(await w.intake.ingest(event())).toEqual({ action: 'ignored', reason: 'flagged' });
    expect(w.store.events).toEqual([]);
  });

  it('flags a mandate claimed after it registered, on its first event', async () => {
    const w = world();
    await w.intake.ingest(created(MANDATE, { key: WRONG_TAG }));
    expect((await w.store.registered(NETWORK, MANDATE))?.flagged).toBe(false);
    w.store.claim(NETWORK, MANDATE, TENANT);
    expect(await w.intake.ingest(event())).toEqual({ action: 'flagged', contractId: MANDATE });
    expect((await w.store.registered(NETWORK, MANDATE))?.flagged).toBe(true);
    expect(w.store.events).toEqual([]);
  });

  it('is never lifted by a later claim with the right tag', async () => {
    const w = world();
    w.store.claim(NETWORK, MANDATE, TENANT);
    await w.intake.ingest(created(MANDATE, { key: WRONG_TAG }));
    await w.store.flag(NETWORK, 'CNOTHING');
    await w.intake.ingest(created(MANDATE));
    expect(await w.intake.ingest(event())).toEqual({ action: 'ignored', reason: 'flagged' });
  });
});
