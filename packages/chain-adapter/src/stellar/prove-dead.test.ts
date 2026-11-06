// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import type { PayRequest } from '../types.js';
import { NETWORK, OPTS } from './test-adapter.js';
import { payRequest, payWorld, record, tombstone } from './test-payouts.js';
import type { PayWorld } from './test-payouts.js';

function prove(w: PayWorld, req: PayRequest) {
  return w.payouts.proveDead(
    { scope: w.scope, mandate: w.mandate, payoutId: req.payoutId, deadline: req.deadline },
    OPTS,
  );
}

const at = (w: PayWorld) => ({
  ledgerOrBlock: BigInt(w.rpc.latest.sequence),
  finality: 'final',
});

describe('proving an attempt dead', { timeout: 30_000 }, () => {
  it('tombstone', async () => {
    for (const [code, status] of [
      [4, 'rejected'],
      [5, 'cancelled'],
    ] as const) {
      const w = payWorld();
      const req = payRequest(w);
      w.views.set(req.payoutId, tombstone(code));
      expect(await prove(w, req)).toEqual({
        kind: 'tombstone',
        network: NETWORK,
        status,
        at: at(w),
      });
    }
  });

  it('deadline passed', async () => {
    const w = payWorld();
    const req = payRequest(w);
    expect(await prove(w, req)).toBeNull();
    w.rpc.latest = { ...w.rpc.latest, closeTime: req.deadline };
    expect(await prove(w, req)).toEqual({
      kind: 'deadline_passed',
      network: NETWORK,
      finalTime: req.deadline,
      at: at(w),
    });
  });

  it('lapsed payout gives payout_lapsed', async () => {
    const w = payWorld();
    const req = payRequest(w);
    const expiresAt = w.rpc.latest.closeTime;
    w.views.set(req.payoutId, record(2, { expiresAt: expiresAt + 1n }));
    expect(await prove(w, req)).toBeNull();
    w.views.set(req.payoutId, record(1, { expiresAt }));
    expect(await prove(w, req)).toEqual({
      kind: 'payout_lapsed',
      network: NETWORK,
      expiresAt,
      finalTime: expiresAt,
      at: at(w),
    });
  });

  it('AGENT_REMOVED gives agent_removed', async () => {
    const w = payWorld();
    const req = payRequest(w);
    w.views.set(req.payoutId, record(2));
    w.refused.set('execute', 'AGENT_REMOVED');
    expect(await prove(w, req)).toEqual({ kind: 'agent_removed', network: NETWORK, at: at(w) });
  });

  it('proves nothing from any other refusal, which may pass later', async () => {
    const w = payWorld();
    const req = payRequest(w);
    w.views.set(req.payoutId, record(2));
    w.refused.set('execute', 'INSUFFICIENT_FUNDS');
    expect(await prove(w, req)).toBeNull();
    w.refused.delete('execute');
    expect(await prove(w, req)).toBeNull();
  });

  it('proves nothing about a payout awaiting approval or already executed', async () => {
    const w = payWorld();
    const req = payRequest(w);
    w.views.set(req.payoutId, record(1));
    w.refused.set('execute', 'AGENT_REMOVED');
    expect(await prove(w, req)).toBeNull();
    w.views.set(req.payoutId, tombstone(3));
    expect(await prove(w, req)).toBeNull();
  });
});
