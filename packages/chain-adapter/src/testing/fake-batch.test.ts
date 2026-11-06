// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Execute batches through the fake adapter: the planner finds the offender
// by simulation, the rest still pays in one submission, an events overflow
// splits the batch, and a removed agent's payout is dropped and reported.

import { describe, expect, it } from 'vitest';

import type { CallOptions, PayRequest } from '../types.js';

import {
  FakeChainAdapter,
  act,
  deployMandate,
  drive,
  fakeAdapterHarness,
  must,
  payRequest,
} from './index.js';

const OPTS: CallOptions = { correlationId: 'batch' };

async function world() {
  const h = fakeAdapterHarness();
  const m = await deployMandate(h);
  return { h, m, net: h.world.net };
}

/** Requests and approves each payout, held, so a batch only executes. */
async function approved(
  h: ReturnType<typeof fakeAdapterHarness>,
  list: readonly PayRequest[],
): Promise<PayRequest[]> {
  for (const req of list) await drive(h.adapter, req);
  return list.map((req) => ({ ...req, execute: 'auto' }));
}

describe('execute batches in the fake adapter', () => {
  it('removes the offender and pays the rest in one submission', async () => {
    const { h, m, net } = await world();
    const bad = must(m.recipients[1], 'a recipient');
    const list = await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        payRequest(h, m, `offender-${String(i)}`, { execute: 'hold', recipient: i === 3 ? 1 : 0 }),
      ),
    );
    const items = await approved(h, list);
    net.faults.transferFails(bad.address.value);
    const step = await h.adapter.payBatch({ scope: h.scope, mandate: m.ref, items }, OPTS);
    expect(step.items.map((i) => i.step.kind)).toEqual([
      'submitted',
      'submitted',
      'submitted',
      'item_failed',
      'submitted',
    ]);
    expect(step.items[3]?.step).toMatchObject({ error: { specCode: 72, retryable: false } });
    expect(step.submissions.length).toBe(1);
    const next = await h.adapter.payBatch({ scope: h.scope, mandate: m.ref, items }, OPTS);
    expect(next.items.map((i) => i.step.kind)).toEqual([
      'final',
      'final',
      'final',
      'item_failed',
      'final',
    ]);
  });

  it('splits a batch over the events limit into two halves and alerts', async () => {
    const { h, m, net } = await world();
    const list = await Promise.all(
      [0, 1, 2, 3].map((i) => payRequest(h, m, `events-${String(i)}`, { execute: 'hold' })),
    );
    const items = await approved(h, list);
    net.faults.batchEventsLimit(2);
    const step = await h.adapter.payBatch({ scope: h.scope, mandate: m.ref, items }, OPTS);
    expect(step.submissions.length).toBe(2);
    expect(step.items.map((i) => i.step.kind)).toEqual([
      'submitted',
      'submitted',
      'submitted',
      'submitted',
    ]);
    expect(h.world.alerts.alerts).toEqual([
      {
        kind: 'batch',
        event: {
          network: net.network,
          kind: 'events_limit',
          scope: h.scope,
          payoutId: null,
          correlationId: 'batch',
        },
      },
    ]);
  });

  it('drops a removed agent payout, alerts the principal and pays the rest', async () => {
    const { h, m, net } = await world();
    const wallet = h.wallet('second-agent');
    await act(h, m.ref, { op: 'add_role', role: 'agent', account: wallet }, m.principal);
    const signer = {
      kind: 'external' as const,
      network: net.network,
      role: 'agent' as const,
      address: wallet,
    };
    const theirs = await payRequest(h, m, 'removed-agent', { execute: 'hold', signer });
    const first = await h.adapter.pay(theirs, OPTS);
    const request = must('request' in first ? first.request : null, 'a signature request');
    await h.adapter.submitSigned(
      {
        scope: h.scope,
        requestId: request.requestId,
        signed: await h.sign(request, wallet),
        correlationId: 'c',
      },
      OPTS,
    );
    const ours = await Promise.all(
      [0, 1].map((i) => payRequest(h, m, `kept-${String(i)}`, { execute: 'hold' })),
    );
    const items = await approved(
      h,
      [ours[0], { ...theirs }, ours[1]].map((r) => must(r, 'item')),
    );
    await act(h, m.ref, { op: 'remove_role', role: 'agent', account: wallet }, m.principal);
    const step = await h.adapter.payBatch({ scope: h.scope, mandate: m.ref, items }, OPTS);
    expect(step.items.map((i) => i.step.kind)).toEqual(['submitted', 'item_failed', 'submitted']);
    expect(step.items[1]?.step).toMatchObject({
      error: { specCode: 65, specName: 'AGENT_REMOVED', retryable: false, waitFor: 'none' },
    });
    expect(h.world.alerts.alerts).toEqual([
      {
        kind: 'batch',
        event: {
          network: net.network,
          kind: 'agent_removed',
          scope: h.scope,
          payoutId: theirs.payoutId,
          correlationId: 'batch',
        },
      },
    ]);
  });

  it('defers the whole batch when the round bound is spent', async () => {
    const { h, m, net } = await world();
    const bad = must(m.recipients[1], 'a recipient');
    const list = await Promise.all(
      [0, 1, 2].map((i) =>
        payRequest(h, m, `bound-${String(i)}`, { execute: 'hold', recipient: i === 1 ? 1 : 0 }),
      ),
    );
    const items = await approved(h, list);
    net.faults.transferFails(bad.address.value);
    const strict = new FakeChainAdapter(
      net,
      {
        store: h.store,
        signer: h.world.signer,
        sponsorship: h.world.sponsorship,
        alerts: h.world.alerts,
        methods: h.world.methods,
      },
      { maxBisectRounds: 0 },
    );
    const step = await strict.payBatch({ scope: h.scope, mandate: m.ref, items }, OPTS);
    expect(step.items.map((i) => i.step.kind)).toEqual(['held', 'held', 'held']);
    expect(step.submissions).toEqual([]);
  });
});
