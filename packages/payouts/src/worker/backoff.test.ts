// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Database } from '@ujira/db';
import { describe, expect, it, vi } from 'vitest';

import { DEAD_LETTER_TRY, afterFailure, retryDelaySeconds } from './backoff.js';
import { AMOUNT_BELOW_MINIMUM, RetryableJobError, TerminalRefusal } from './errors.js';
import { payoutAdvance, tenantTask, type TenantJob } from './handlers.js';
import { PAYOUT_ADVANCE } from './tasks.js';
import { helpersFor } from './testing/support.js';

const PAYLOAD = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
  payoutId: 'p1',
  mandateId: 'm1',
};

describe('the backoff curve', () => {
  it('delays 5 s doubling to 600 s cap, dead letter at try 12', () => {
    const delays: number[] = [];
    let tryNumber = 1;
    for (;;) {
      const next = afterFailure(tryNumber);
      if (next.kind === 'dead_letter') break;
      expect(next.tryNumber).toBe(tryNumber + 1);
      delays.push(next.delaySeconds);
      tryNumber = next.tryNumber;
    }
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 320, 600, 600, 600, 600]);
    expect(tryNumber).toBe(12);
    expect(DEAD_LETTER_TRY).toBe(12);
  });

  it('stays dead lettered past the last try, and stays capped however far it goes', () => {
    expect(afterFailure(13)).toEqual({ kind: 'dead_letter' });
    expect(retryDelaySeconds(1_000)).toBe(600);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a try number of %s', (tryNumber) => {
    expect(() => retryDelaySeconds(tryNumber)).toThrow(RangeError);
  });
});

describe('payout:advance', () => {
  function portsThat(quote: () => Promise<string>) {
    return {
      quote: vi.fn(quote),
      submit: vi.fn<(job: TenantJob, quote: string) => Promise<void>>(() => Promise.resolve()),
      reject: vi.fn<(job: TenantJob, reason: string) => Promise<void>>(() => Promise.resolve()),
    };
  }

  // Any database use throws, so the absence of a re-enqueue is proved, not assumed.
  const noDatabase = {
    tenant: () => {
      throw new Error('this path must not open a transaction');
    },
  } as unknown as Database;

  it('AMOUNT_BELOW_MINIMUM ends the job with no re-enqueue and no adapter call', async () => {
    const ports = portsThat(() => Promise.reject(new TerminalRefusal(AMOUNT_BELOW_MINIMUM)));
    const task = tenantTask(PAYOUT_ADVANCE, payoutAdvance(ports), {
      db: noDatabase,
      alert: () => {
        throw new Error('a refusal is not an alert');
      },
    });
    await task(PAYLOAD, helpersFor('1'));
    expect(ports.submit).not.toHaveBeenCalled();
    expect(ports.reject).toHaveBeenCalledTimes(1);
    expect(ports.reject.mock.calls[0]?.[1]).toBe(AMOUNT_BELOW_MINIMUM);
  });

  it('a quote goes on to be submitted, with the payload it came from', async () => {
    const ports = portsThat(() => Promise.resolve('the quote'));
    await payoutAdvance(ports)({
      context: { principalId: PAYLOAD.principalId, projectId: PAYLOAD.projectId },
      ids: { payoutId: 'p1' },
      tryNumber: 1,
      signal: new AbortController().signal,
    });
    expect(ports.submit.mock.calls[0]?.[1]).toBe('the quote');
    expect(ports.reject).not.toHaveBeenCalled();
  });

  it('a retryable failure at the quote is not a refusal', async () => {
    const failure = new RetryableJobError('RPC_UNAVAILABLE');
    const ports = portsThat(() => Promise.reject(failure));
    await expect(
      payoutAdvance(ports)({
        context: { principalId: PAYLOAD.principalId, projectId: PAYLOAD.projectId },
        ids: { payoutId: 'p1' },
        tryNumber: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure);
    expect(ports.reject).not.toHaveBeenCalled();
    expect(ports.submit).not.toHaveBeenCalled();
  });

  it('anything unexpected goes to the built in attempts, with no re-enqueue', async () => {
    const bug = new TypeError('a bug');
    const task = tenantTask(PAYOUT_ADVANCE, () => Promise.reject(bug), {
      db: noDatabase,
      alert: () => undefined,
    });
    await expect(task(PAYLOAD, helpersFor('1'))).rejects.toBe(bug);
  });
});

describe('error codes', () => {
  it.each(['lower case', 'HAS SPACE', '', 'A'.repeat(65)])('refuses %j', (code) => {
    expect(() => new RetryableJobError(code)).toThrow(RangeError);
    expect(() => new TerminalRefusal(code)).toThrow(RangeError);
  });
});
