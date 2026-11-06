// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * The request the payout job sends carries the fee the builder worked out,
 * and the fake chain takes exactly total plus fee from the mandate. The job
 * itself arrives with the payout advance work; this checks the request it
 * will send.
 */

import { describe, expect, it } from 'vitest';

import { deployMandate, drive, fakeAdapterHarness, payRequest } from '@ujira/chain-adapter/testing';
import { tokenAmount } from '@ujira/core';

import { applyFee, withFee } from './index.js';

const OPTS = { correlationId: 'advance-fee' };

describe('advance', () => {
  it('request_payout is built with total and fee', async () => {
    const h = fakeAdapterHarness();
    const m = await deployMandate(h, { maxFeeBps: 50, fund: 10_000_000n });
    const { fee: unset, ...unpriced } = await payRequest(h, m, 'priced', { total: 1_000_000n });
    expect(unset.amount).toBe(0n);
    const config = (await h.adapter.readMandate({ scope: h.scope, mandate: m.ref }, OPTS)).config;
    const applied = applyFee(
      unpriced.total,
      { id: 'terms-1', rateBps: 90, basis: 'standard', validFrom: new Date(0) },
      config.maxFeeBps,
    );
    const request = withFee(unpriced, applied);

    expect(request.total).toEqual(tokenAmount(1_000_000n, 'USDC', 'stellar'));
    expect(request.fee).toEqual(tokenAmount(5_000n, 'USDC', 'stellar'));
    expect(applied.bpsApplied).toBe(50);

    const steps = await drive(h.adapter, request);
    expect(steps.at(-1)?.kind).toBe('final');
    const after = await h.adapter.readMandate({ scope: h.scope, mandate: m.ref }, OPTS);
    expect(after.state.spent).toEqual(applied.charged);
  });
});
