// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { CallAbortedError, CallTimeoutError } from './errors.js';
import { withTimeout } from './timeout.js';

const never = (): Promise<never> => new Promise<never>(() => undefined);

describe('withTimeout', () => {
  it('passes a value and an error through untouched', async () => {
    expect(await withTimeout(1_000, undefined, () => Promise.resolve(7))).toBe(7);
    const boom = new Error('boom');
    await expect(withTimeout(1_000, undefined, () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('settles with CallTimeoutError when the call ignores its signal', async () => {
    let seen: AbortSignal | undefined;
    const run = withTimeout(20, undefined, (signal) => {
      seen = signal;
      return never();
    });
    await expect(run).rejects.toThrow(CallTimeoutError);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(CallTimeoutError);
  });

  it("the caller's abort wins, before and during the call", async () => {
    const before = new AbortController();
    before.abort(new Error('gone'));
    let called = false;
    const early = withTimeout(1_000, before.signal, () => {
      called = true;
      return never();
    });
    await expect(early).rejects.toThrow(CallAbortedError);
    expect(called).toBe(false);

    const during = new AbortController();
    const late = withTimeout(1_000, during.signal, () => never());
    during.abort(new Error('gone'));
    const error = await late.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallAbortedError);
    expect((error as Error).cause).toEqual(new Error('gone'));
  });

  it('a settled call stops listening to the caller', async () => {
    const controller = new AbortController();
    expect(await withTimeout(1_000, controller.signal, () => Promise.resolve('done'))).toBe('done');
    controller.abort();
  });
});
