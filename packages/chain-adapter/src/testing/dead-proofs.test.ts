// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The fake must name a dead attempt's reason as the real adapter does, or failover
// and reporting tested against it could not tell the two apart.

import { describe, expect, it } from 'vitest';

import type { CallOptions, PayRequest } from '../types.js';
import { act, deployMandate, drive, payRequest } from './conformance.js';
import { fakeAdapterHarness } from './fake-world.js';

const OPTS: CallOptions = { correlationId: 'dead-proofs' };
const DAY = 86_400n;

async function held() {
  const h = fakeAdapterHarness();
  const m = await deployMandate(h);
  const req = await payRequest(h, m, 'open', { execute: 'hold' });
  await drive(h.adapter, req);
  const prove = (r: PayRequest) =>
    h.adapter.proveDead(
      { scope: h.scope, mandate: m.ref, payoutId: r.payoutId, deadline: r.deadline },
      OPTS,
    );
  return { h, m, req, prove };
}

describe('dead proofs on the fake', () => {
  it('proves nothing about a payout that can still execute', async () => {
    const { req, prove } = await held();
    expect(await prove(req)).toBeNull();
  });

  it('lapsed payout gives payout_lapsed', async () => {
    const { h, req, prove } = await held();
    await h.advance(DAY + 1n);
    expect(await prove(req)).toMatchObject({ kind: 'payout_lapsed', network: h.adapter.network });
  });

  it('AGENT_REMOVED gives agent_removed', async () => {
    const { h, m, req, prove } = await held();
    await act(
      h,
      m.ref,
      { op: 'remove_role', role: 'agent', account: h.managedAgent.address },
      m.principal,
    );
    expect(await prove(req)).toMatchObject({ kind: 'agent_removed', network: h.adapter.network });
  });
});
