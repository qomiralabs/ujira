// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Faults are drawn from the plan's own seeded generator and nothing else,
// so one seed replays one run exactly, which is what makes a failing
// property case worth having.

import { describe, expect, it } from 'vitest';

import { ChainAdapterError } from '../errors.js';
import type { CallOptions, CountryCode } from '../types.js';

import {
  FakeFaults,
  SimulatedCrash,
  deployMandate,
  fakeAdapterHarness,
  payRequest,
} from './index.js';

const OPTS: CallOptions = { correlationId: 'faults-test' };

async function tracedRun(seed: number): Promise<readonly string[]> {
  const h = fakeAdapterHarness({ seed });
  const m = await deployMandate(h);
  const faults = h.world.net.faults;
  faults.randomize({
    timeoutAfterLanding: 3_000,
    chainDown: 2_000,
    after_record: 1_000,
    after_broadcast: 1_000,
  });
  let adapter = h.adapter;
  for (const label of ['a', 'b', 'c', 'd']) {
    const req = await payRequest(h, m, `${label}-${String(seed)}`);
    for (let i = 0; i < 8; i += 1) {
      try {
        const step = await adapter.pay(req, OPTS);
        if (step.kind === 'final') break;
      } catch (error) {
        if (error instanceof SimulatedCrash) adapter = h.restart();
        else if (!(error instanceof ChainAdapterError)) throw error;
      }
    }
  }
  return [...faults.trace];
}

describe('fault injection', () => {
  it('the same seed gives the same trace', async () => {
    const first = await tracedRun(7);
    expect(first.some((line) => line.startsWith('fault '))).toBe(true);
    expect(await tracedRun(7)).toEqual(first);
    expect(await tracedRun(8)).not.toEqual(first);
  });

  it('fires scripted faults once each and records them', () => {
    const faults = new FakeFaults(3);
    faults.timeoutAfterLanding(1);
    expect(faults.takeTimeout()).toBe(true);
    expect(faults.takeTimeout()).toBe(false);
    faults.crash('after_record', 1);
    expect(() => {
      faults.crashPoint('after_record');
    }).toThrow(SimulatedCrash);
    expect(() => {
      faults.crashPoint('after_record');
    }).not.toThrow();
    faults.randomize({ after_broadcast: 10_000 });
    expect(() => {
      faults.crashPoint('after_broadcast');
    }).toThrow(SimulatedCrash);
    faults.clear();
    expect(faults.isChainDown()).toBe(false);
    expect(faults.trace).toEqual([
      'fault timeoutAfterLanding',
      'fault after_record',
      'fault after_broadcast',
    ]);
  });

  it('refuses a plan it cannot run', () => {
    const faults = new FakeFaults();
    expect(() => new FakeFaults(0.5)).toThrow(ChainAdapterError);
    expect(() => {
      faults.randomize({ chainDown: 10_001 });
    }).toThrow(ChainAdapterError);
    expect(() => {
      faults.timeoutAfterLanding(-1);
    }).toThrow(ChainAdapterError);
    const anchor = {
      anchorId: 'a',
      currency: 'NGN' as const,
      country: 'NG' as CountryCode,
      rate: { numerator: 1n, denominator: 1n },
      fee: 0n,
      steps: [],
    };
    expect(() => {
      faults.anchorScript({ ...anchor, fee: -1n });
    }).toThrow(ChainAdapterError);
    expect(() => {
      faults.anchorScript({
        ...anchor,
        steps: [{ afterSeconds: -1, state: 'delivered', rawStatus: 'x' }],
      });
    }).toThrow(ChainAdapterError);
    faults.anchorScript(anchor);
    expect(faults.anchor).toEqual(anchor);
    faults.anchorScript(null);
    expect(faults.anchor).toBe(null);
  });
});
