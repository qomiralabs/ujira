// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Cancelling a lapsed payout, against the fake chain, whose engine follows the contract's
// rule on who may cancel. A lapsed payout can be cancelled by anyone. An open one cannot
// be cancelled by an executor, however it asks.

import { describe, expect, it } from 'vitest';

import type { CallOptions } from '../types.js';

import { act, deployMandate, drive, fakeAdapterHarness, must, payRequest } from './index.js';

const OPTS: CallOptions = { correlationId: 'cancel-lapsed' };
const TTL = 86_400n;

async function world() {
  const h = fakeAdapterHarness();
  const m = await deployMandate(h);
  return { h, m, net: h.world.net };
}

// Requested and approved, and not executed.
async function openPayout(label: string) {
  const w = await world();
  const req = await payRequest(w.h, w.m, label, { execute: 'hold' });
  await drive(w.h.adapter, req);
  return { ...w, req };
}

const cancelsOf = (net: ReturnType<typeof fakeAdapterHarness>['world']['net']) =>
  net.txs.flatMap((tx) => tx.events).filter((event) => event.name === 'payout_cancelled');

describe('who may cancel, by the contract', () => {
  it('an executor cannot cancel an open payout', async () => {
    const { h, m, net, req } = await openPayout('open');
    const executor = must(h.executors[0], 'an executor');
    await expect(
      act(h, m.ref, { op: 'cancel', payoutId: req.payoutId }, executor),
    ).rejects.toMatchObject({ specName: 'UNAUTHORIZED' });
    expect(cancelsOf(net)).toHaveLength(0);
  });

  it('nor one past the deadline that has not reached its own expiry', async () => {
    const { h, m, req } = await openPayout('near');
    const executor = must(h.executors[0], 'an executor');
    await h.advance(TTL - 60n);
    await expect(
      act(h, m.ref, { op: 'cancel', payoutId: req.payoutId }, executor),
    ).rejects.toMatchObject({ specName: 'UNAUTHORIZED' });
  });
});

describe('cancelLapsed', () => {
  const cancel = (w: Awaited<ReturnType<typeof openPayout>>) =>
    w.h.adapter.cancelLapsed(
      { scope: w.h.scope, mandate: w.m.ref, payoutId: w.req.payoutId },
      OPTS,
    );

  it('sends nothing for a payout that has not lapsed', async () => {
    const w = await openPayout('not-yet');
    const before = w.net.txs.length;
    expect(await cancel(w)).toEqual({ kind: 'not_lapsed' });
    expect(w.net.txs).toHaveLength(before);
  });

  it('cancels a lapsed payout as the executor, with reason 3, and frees its funds', async () => {
    const w = await openPayout('lapsed');
    const read = async () =>
      (await w.h.adapter.readMandate({ scope: w.h.scope, mandate: w.m.ref }, OPTS)).state.free
        .amount;
    const held = await read();
    await w.h.advance(TTL + 60n);
    expect((await cancel(w)).kind).toBe('submitted');
    await w.h.advance(6n);
    expect(await cancel(w)).toEqual({ kind: 'cancelled', final: true });
    expect(await read()).toBeGreaterThan(held);
    const [event] = cancelsOf(w.net);
    expect(event?.fields).toMatchObject({
      by: must(w.h.executors[0], 'an executor').value,
      reason: 3,
    });
  });

  it('sends once however often it is asked', async () => {
    const w = await openPayout('twice');
    await w.h.advance(TTL + 60n);
    await cancel(w);
    await cancel(w);
    await w.h.advance(6n);
    await cancel(w);
    await cancel(w);
    expect(cancelsOf(w.net)).toHaveLength(1);
  });

  it('survives a process that died after sending', async () => {
    const w = await openPayout('crash');
    await w.h.advance(TTL + 60n);
    w.net.faults.crash('after_broadcast');
    await expect(cancel(w)).rejects.toThrow();
    await w.h.advance(6n);
    const restarted = w.h.restart();
    await restarted.cancelLapsed(
      { scope: w.h.scope, mandate: w.m.ref, payoutId: w.req.payoutId },
      OPTS,
    );
    await w.h.advance(6n);
    expect(cancelsOf(w.net)).toHaveLength(1);
  });

  it('reports a payout already closed, and sends nothing', async () => {
    const w = await world();
    const req = await payRequest(w.h, w.m, 'paid');
    await drive(w.h.adapter, req);
    await w.h.advance(6n);
    await drive(w.h.adapter, req);
    const before = w.net.txs.length;
    expect(
      await w.h.adapter.cancelLapsed(
        { scope: w.h.scope, mandate: w.m.ref, payoutId: req.payoutId },
        OPTS,
      ),
    ).toEqual({ kind: 'closed', status: 'executed' });
    expect(w.net.txs).toHaveLength(before);
  });

  it('reports a payout the chain never saw', async () => {
    const w = await world();
    const req = await payRequest(w.h, w.m, 'never');
    expect(
      await w.h.adapter.cancelLapsed(
        { scope: w.h.scope, mandate: w.m.ref, payoutId: req.payoutId },
        OPTS,
      ),
    ).toEqual({ kind: 'absent' });
  });

  it("refuses another tenant's mandate", async () => {
    const w = await openPayout('tenant');
    await expect(
      w.h.adapter.cancelLapsed(
        { scope: w.h.otherScope, mandate: w.m.ref, payoutId: w.req.payoutId },
        OPTS,
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  });
});
