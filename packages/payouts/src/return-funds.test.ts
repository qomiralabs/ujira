// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for returning a closed mandate's funds (return-funds.ts), CHAINOPS-SWEEP-001
 * to 004, against the fake chain.
 *
 * - Money only ever leaves through the adapter's sweep, which has no destination: the
 *   contract pays its principal. A balance of zero on chain, from a withdraw or an
 *   earlier sweep, ends the job without an attempt.
 * - It sweeps a revoked mandate at once, an expired one only after the grace, never
 *   while a principal change is pending, and never past a third-party inflow that
 *   operations have not cleared, whose alert is raised first.
 * - A principal that cannot receive yet is retried 5 s doubling to 600 s, dead lettered
 *   at try 12, and told once per reason with the fix.
 * - Each sweep is booked once by its event's chain, transaction and index, and a run
 *   tells each principal once, however many mandates it swept for them.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  ChainAddress,
  MandateRef,
  ReceivabilityReason,
  TenantScope,
} from '@ujira/chain-adapter';
import { act, deployMandate, fakeAdapterHarness, refusalOf } from '@ujira/chain-adapter/testing';
import { tokenAmount } from '@ujira/core';

import {
  RETURN_FUNDS_BACKOFF,
  RETURN_FUNDS_TASK,
  ReturnFundsPayloadError,
  bookSwept,
  notifySweepRun,
  returnFundsDelayMs,
  returnFundsJobKey,
  runReturnFunds,
} from './index.js';
import type {
  BookedSweep,
  InflowState,
  ReturnFundsAdapter,
  ReturnFundsDeps,
  ReturnFundsNotice,
  ReturnFundsPayload,
  SweepBookings,
  SweptEvent,
} from './index.js';

const FUNDS = 10_000_000n;
const DAY = 86_400n;
const GRACE = 30n * DAY;
const INSTANCE = '7a1d3c52-6d5e-4f8a-9b0c-1e2f3a4b5c6d';

type Harness = ReturnType<typeof fakeAdapterHarness>;

function faultsOf(h: Harness) {
  if (h.faults === null) throw new Error('the fake chain has faults');
  return h.faults;
}

/** What a database version must match, with a Set in place of each unique constraint. */
function memory() {
  const inflows = new Map<string, InflowState>();
  const raised: string[] = [];
  const told = new Set<string>();
  const notices: ReturnFundsNotice[] = [];
  const deadLetters: { instanceId: string; reason: string }[] = [];
  const keyOf = (scope: TenantScope, id: string) => `${scope.principalId}/${scope.projectId}/${id}`;
  const ports = {
    store: {
      inflow: (scope: TenantScope, instanceId: string) =>
        Promise.resolve(inflows.get(keyOf(scope, instanceId)) ?? 'none'),
      raiseInflowAlert: (scope: TenantScope, instanceId: string) => {
        const key = keyOf(scope, instanceId);
        if (inflows.get(key) === 'detected') {
          inflows.set(key, 'alerted');
          raised.push(key);
        }
        return Promise.resolve();
      },
      firstNotice: (scope: TenantScope, instanceId: string, reason: string) => {
        const key = `${keyOf(scope, instanceId)}/${reason}`;
        if (told.has(key)) return Promise.resolve(false);
        told.add(key);
        return Promise.resolve(true);
      },
    },
    notices: {
      cannotReceive: (notice: ReturnFundsNotice) => {
        notices.push(notice);
        return Promise.resolve();
      },
    },
    alerts: {
      deadLetter: (alert: { scope: TenantScope; instanceId: string; reason: string }) => {
        deadLetters.push({ instanceId: alert.instanceId, reason: alert.reason });
        return Promise.resolve();
      },
    },
  };
  const inflowOf = (scope: TenantScope, state: InflowState) =>
    inflows.set(keyOf(scope, INSTANCE), state);
  return { ports, inflowOf, raised, notices, deadLetters };
}

async function setup() {
  const h = fakeAdapterHarness();
  const m = await deployMandate(h, { fund: FUNDS });
  const mem = memory();
  const deps: ReturnFundsDeps = { adapter: h.adapter, ...mem.ports };
  const payload = (tries = 0, scope: TenantScope = h.scope): ReturnFundsPayload => ({
    principalId: scope.principalId,
    projectId: scope.projectId,
    instanceId: INSTANCE,
    network: h.adapter.network,
    mandate: m.ref.address.value,
    tries,
  });
  const run = (tries = 0) => runReturnFunds(payload(tries), deps);
  const sweeps = () => h.moves().filter((move) => move.to === 'built').length;
  return { h, m, deps, payload, run, sweeps, ...mem };
}

describe('the return funds job', () => {
  it('is keyed once per mandate instance', () => {
    expect(RETURN_FUNDS_TASK).toBe('mandate:return_funds');
    expect(returnFundsJobKey(INSTANCE)).toBe(`mandate:${INSTANCE}:return_funds`);
  });

  it('revoked mandate is swept at once', async () => {
    const w = await setup();
    await act(w.h, w.m.ref, { op: 'revoke' }, w.m.principal);
    const before = await w.h.balance(w.m.principal);
    const outcome = await w.run();
    expect(outcome.kind).toBe('swept');
    expect((await w.h.balance(w.m.principal)) - before).toBe(FUNDS);
  });

  it('every prepared return has the principal as destination', async () => {
    // The only way out has nowhere to name another address.
    expectTypeOf<Parameters<ReturnFundsAdapter['sweepToPrincipal']>[0]>().toEqualTypeOf<{
      readonly scope: TenantScope;
      readonly mandate: MandateRef;
    }>();
    const w = await setup();
    await act(w.h, w.m.ref, { op: 'revoke' }, w.m.principal);
    const watched: ChainAddress[] = [
      ...w.m.recipients.map((r) => r.address),
      ...w.m.approvers,
      w.h.wallet('stranger'),
    ];
    const others = await Promise.all(watched.map((a) => w.h.balance(a)));
    const principal = await w.h.balance(w.m.principal);
    await w.run();
    expect((await w.h.balance(w.m.principal)) - principal).toBe(FUNDS);
    expect(await Promise.all(watched.map((a) => w.h.balance(a)))).toEqual(others);
    const events = w.h.world.net.txs.flatMap((tx) => tx.events).map((e) => e.name);
    expect(events.filter((name) => name === 'swept')).toHaveLength(1);
  });

  it('zero balance on chain ends the job without an attempt', async () => {
    const w = await setup();
    await act(w.h, w.m.ref, { op: 'revoke' }, w.m.principal);
    // The principal took it back first.
    const amount = tokenAmount(FUNDS, 'USDC', 'stellar');
    await act(w.h, w.m.ref, { op: 'withdraw', amount }, w.m.principal);
    const sent = w.sweeps();
    expect(await w.run()).toEqual({ kind: 'done', reason: 'nothing_left' });
    expect(w.sweeps()).toBe(sent);
  });

  it('never sweeps a mandate that is still open', async () => {
    const w = await setup();
    const sent = w.sweeps();
    expect(await w.run()).toEqual({ kind: 'done', reason: 'not_closed' });
    expect(w.sweeps()).toBe(sent);
  });

  it('expired unrevoked mandate inside the grace is skipped', async () => {
    const w = await setup();
    await w.h.advance(w.m.expiresAt - (await nowOf(w.h)) + 1n);
    const sent = w.sweeps();
    expect(await w.run()).toEqual({
      kind: 'wait',
      reason: 'grace',
      runAt: w.m.expiresAt + GRACE,
    });
    expect(w.sweeps()).toBe(sent);
    await w.h.advance(GRACE);
    expect((await w.run()).kind).toBe('swept');
  });

  it('pending principal change is skipped', async () => {
    const w = await setup();
    const next = w.h.wallet('next-principal');
    await act(w.h, w.m.ref, { op: 'propose_principal', proposed: next }, w.m.principal);
    await w.h.advance(w.m.expiresAt - (await nowOf(w.h)) + GRACE + 1n);
    const sent = w.sweeps();
    expect(await w.run()).toMatchObject({ kind: 'wait', reason: 'principal_change' });
    expect(w.sweeps()).toBe(sent);
    await act(w.h, w.m.ref, { op: 'cancel_principal_proposal' }, w.m.principal);
    expect((await w.run()).kind).toBe('swept');
  });

  it('an uncleared third-party inflow alert blocks the sweep', async () => {
    const w = await setup();
    await act(w.h, w.m.ref, { op: 'revoke' }, w.m.principal);
    w.inflowOf(w.h.scope, 'detected');
    const sent = w.sweeps();
    // The alert exists before anything else happens, and holds the sweep.
    expect(await w.run()).toMatchObject({ kind: 'wait', reason: 'third_party_inflow' });
    expect(w.raised).toHaveLength(1);
    expect(await w.run()).toMatchObject({ kind: 'wait', reason: 'third_party_inflow' });
    expect(w.raised).toHaveLength(1);
    expect(w.sweeps()).toBe(sent);
    w.inflowOf(w.h.scope, 'cleared');
    expect((await w.run()).kind).toBe('swept');
  });

  it('delays 5 s doubling to 600 s, dead letter at try 12', async () => {
    expect(RETURN_FUNDS_BACKOFF).toEqual({ firstMs: 5_000, maxMs: 600_000, deadLetterAt: 12 });
    expect(Array.from({ length: 11 }, (_, i) => returnFundsDelayMs(i + 1))).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000, 600_000, 600_000,
    ]);
    const w = await setup();
    await act(w.h, w.m.ref, { op: 'revoke' }, w.m.principal);
    faultsOf(w.h).transferFails(w.m.principal);
    const sent = w.sweeps();
    const delays: number[] = [];
    let tries = 0;
    for (;;) {
      const outcome = await w.run(tries);
      if (outcome.kind !== 'retry') {
        expect(outcome).toEqual({ kind: 'dead_letter', reason: 'TRANSFER_FAILED', tries: 12 });
        break;
      }
      delays.push(outcome.delayMs);
      tries = outcome.payload.tries;
    }
    expect(delays).toHaveLength(11);
    expect(delays.at(-1)).toBe(600_000);
    expect(w.deadLetters).toEqual([{ instanceId: INSTANCE, reason: 'TRANSFER_FAILED' }]);
    // A refused sweep is refused in simulation: nothing was ever sent.
    expect(w.sweeps()).toBe(sent);
  });

  it('repeated TRANSFER_FAILED for the same reason notifies once', async () => {
    const w = await setup();
    await act(w.h, w.m.ref, { op: 'revoke' }, w.m.principal);
    faultsOf(w.h).transferFails(w.m.principal);
    w.h.world.net.setLedgerTrustline(w.m.principal.value, null);
    for (let tries = 0; tries < 4; tries += 1) {
      expect((await w.run(tries)).kind).toBe('retry');
    }
    expect(w.notices).toEqual([
      {
        scope: w.h.scope,
        instanceId: INSTANCE,
        mandate: w.m.ref,
        reason: 'NO_TRUSTLINE' satisfies ReceivabilityReason,
        fix: 'add_trustline',
      },
    ]);
    // Fixed, the next try returns the funds.
    faultsOf(w.h).transferFails(w.m.principal, false);
    w.h.world.net.activateRecipient(w.m.principal.value);
    expect((await w.run(4)).kind).toBe('swept');
  });

  it('acts only for the tenant in its payload', async () => {
    const w = await setup();
    await act(w.h, w.m.ref, { op: 'revoke' }, w.m.principal);
    const sent = w.sweeps();
    const error = await refusalOf(runReturnFunds(w.payload(0, w.h.otherScope), w.deps));
    expect(error).toMatchObject({ code: 'TENANT_MISMATCH' });
    expect(w.sweeps()).toBe(sent);
  });

  it('refuses a payload it cannot read, naming the field and never its value', async () => {
    const w = await setup();
    const bad = [
      null,
      { ...w.payload(), instanceId: 'not-a-uuid' },
      { ...w.payload(), tries: -1 },
      { ...w.payload(), tries: 13 },
      { ...w.payload(), extra: 'x' },
    ];
    for (const raw of bad) {
      const error = await runReturnFunds(raw, w.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReturnFundsPayloadError);
      expect((error as Error).message).not.toContain('not-a-uuid');
    }
  });
});

describe('booking and telling the principal', () => {
  const scope = (principalId: string, projectId: string): TenantScope =>
    ({ principalId, projectId }) as TenantScope;
  const A = scope('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
  const B = scope('33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444');

  function bookings(): SweepBookings & { readonly booked: BookedSweep[] } {
    const keys = new Set<string>();
    const booked: BookedSweep[] = [];
    return {
      booked,
      book: (event: SweptEvent) => {
        const key = `${event.chain}/${event.txHash}/${event.eventIndex.toString()}`;
        if (keys.has(key)) return Promise.resolve('duplicate' as const);
        keys.add(key);
        booked.push({ ...event });
        return Promise.resolve('booked' as const);
      },
    };
  }

  function swept(over: Partial<SweptEvent> = {}): SweptEvent {
    return {
      scope: A,
      instanceId: INSTANCE,
      chain: 'stellar',
      txHash: 'ab'.repeat(32),
      eventIndex: 0n,
      ledger: 100n,
      amount: tokenAmount(FUNDS, 'USDC', 'stellar'),
      finalizedAt: new Date(0),
      ...over,
    };
  }

  it('a replayed swept event books one sweep', async () => {
    const store = bookings();
    expect(await bookSwept(swept(), store)).toBe('booked');
    // The same event, from a restarted indexer or whoever triggered the sweep.
    expect(await bookSwept(swept(), store)).toBe('duplicate');
    expect(await bookSwept(swept({ eventIndex: 1n }), store)).toBe('booked');
    expect(store.booked).toHaveLength(2);
    // An event it cannot trust is refused before the store sees it.
    await expect(bookSwept(swept({ txHash: 'nope' }), store)).rejects.toBeInstanceOf(
      ReturnFundsPayloadError,
    );
    await expect(bookSwept(swept({ eventIndex: -1n }), store)).rejects.toBeInstanceOf(
      ReturnFundsPayloadError,
    );
    expect(store.booked).toHaveLength(2);
  });

  it('ten sweeps for one principal in a run send one message', async () => {
    const sent: { principalId: string; count: number }[] = [];
    const run: BookedSweep[] = [
      ...Array.from({ length: 10 }, (_, i) =>
        swept({ txHash: i.toString(16).padStart(64, '0'), instanceId: `instance-${String(i)}` }),
      ),
      swept({ scope: B, txHash: 'ff'.repeat(32) }),
    ];
    await notifySweepRun(run, {
      fundsReturned: (message) => {
        sent.push({ principalId: message.principalId, count: message.sweeps.length });
        return Promise.resolve();
      },
    });
    expect(sent).toEqual([
      { principalId: A.principalId, count: 10 },
      { principalId: B.principalId, count: 1 },
    ]);
  });
});

async function nowOf(h: Harness): Promise<bigint> {
  return (await h.adapter.health({ correlationId: 'return-funds' })).checkedAt;
}
