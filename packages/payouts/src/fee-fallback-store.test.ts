// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Which session each port uses and how rows map. The repositories are stood in for here,
// because the database test harness belongs to the database package. The constraints, the
// rollback and the races are tested there against a real server, in fee-fallback.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeadProof, NetworkId, PayRequest, PayoutId, TenantScope } from '@ujira/chain-adapter';
import type { Database, PayoutAttempt } from '@ujira/db';
import { tokenAmount } from '@ujira/core';

import { FeeResendPayoutMismatchError, createFeeFallbackStore } from './index.js';

const repo = vi.hoisted(() => ({
  decide: vi.fn(),
  decided: vi.fn(),
  resend: vi.fn(),
  raise: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('@ujira/db', () => ({
  feeFallback: { decide: repo.decide, decided: repo.decided, resend: repo.resend },
  feeAddressAlarms: { raise: repo.raise, clear: repo.clear },
}));

const NETWORK = 'stellar:testnet' as NetworkId;
const CHAIN_ID = 'ab'.repeat(32) as PayoutId;
const SCOPE = { principalId: 'principal', projectId: 'project' } as unknown as TenantScope;
const OPTS = { signal: new AbortController().signal };
const PROOF = { kind: 'payout_lapsed' } as unknown as DeadProof;
const usdc = (amount: bigint) => tokenAmount(amount, 'USDC', 'stellar');

const FAILED = {
  scope: SCOPE,
  payoutId: CHAIN_ID,
  attempt: 1,
  total: usdc(1_000_000n),
  fee: usdc(5_000n),
  deadline: 1n,
  attestations: [],
  legs: [{ index: 0, legKey: 'old', amount: usdc(1_000_000n) }],
} as unknown as PayRequest;

const RESEND = {
  scope: SCOPE,
  payout: 'payout-1',
  failed: FAILED,
  unpaidFee: FAILED.fee,
  proof: PROOF,
};

function world() {
  const opened: { session: string; arg: unknown }[] = [];
  const db = {
    tenant: (context: unknown) => ({
      transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        opened.push({ session: 'tenant', arg: context });
        return work('tx');
      },
    }),
    unscoped: async (work: (tx: unknown) => Promise<unknown>, role: unknown) => {
      opened.push({ session: 'unscoped', arg: role });
      return work('tx');
    },
  } as unknown as Pick<Database, 'tenant' | 'unscoped'>;
  const cannotReceive = vi.fn(() => Promise.resolve());
  const chainIdFor = vi.fn(() => 'cd'.repeat(32) as PayoutId);
  const store = createFeeFallbackStore({
    db,
    attemptDeadline: () => new Date(1000),
    chainIdFor,
    identityOf: (_failed, attempt) => ({
      payoutId: attempt.onChainPayoutId as PayoutId,
      legKeys: ['new' as PayRequest['legs'][number]['legKey']],
      deadline: 2n as PayRequest['deadline'],
      attestations: [],
    }),
    alerts: { cannotReceive },
  });
  return { store, opened, cannotReceive, chainIdFor };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createFeeFallbackStore', () => {
  it('decides and reads the decision in the tenant session', async () => {
    const { store, opened } = world();
    repo.decided.mockResolvedValue(true);
    await store.decideResend(SCOPE, CHAIN_ID, OPTS);
    expect(await store.resendDecided(SCOPE, CHAIN_ID, OPTS)).toBe(true);
    expect(repo.decide).toHaveBeenCalledWith('tx', CHAIN_ID);
    expect(repo.decided).toHaveBeenCalledWith('tx', CHAIN_ID);
    expect(opened).toEqual([
      { session: 'tenant', arg: SCOPE },
      { session: 'tenant', arg: SCOPE },
    ]);
  });

  it('resends with the fee, the proof and the new identity', async () => {
    const { store, opened, chainIdFor } = world();
    repo.resend.mockImplementation((_tx: unknown, input: { chainIdFor: (n: number) => string }) => {
      input.chainIdFor(2);
      return Promise.resolve({
        attempt: { payoutId: 'payout-1', onChainPayoutId: 'new-id' } as PayoutAttempt,
        created: true,
      });
    });

    const request = await store.resendWithoutFee(RESEND, OPTS);

    expect(request).toMatchObject({
      payoutId: 'new-id',
      attempt: 2,
      fee: usdc(0n),
      legs: [{ legKey: 'new' }],
    });
    expect(repo.resend).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({
        failedOnChainId: CHAIN_ID,
        proof: PROOF,
        fee: FAILED.fee,
        deadline: new Date(1000),
      }),
    );
    expect(chainIdFor).toHaveBeenCalledWith('payout-1', 2);
    expect(opened).toEqual([{ session: 'tenant', arg: SCOPE }]);
  });

  it('throws inside the transaction when the attempt is of another payout', async () => {
    const { store } = world();
    repo.resend.mockResolvedValue({
      attempt: { payoutId: 'payout-2', onChainPayoutId: 'new-id' } as PayoutAttempt,
      created: true,
    });
    await expect(store.resendWithoutFee(RESEND, OPTS)).rejects.toBeInstanceOf(
      FeeResendPayoutMismatchError,
    );
  });

  it('alerts only the call that raised the alarm, in the worker session', async () => {
    const { store, opened, cannotReceive } = world();
    repo.raise.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await store.raiseAddressAlarm(NETWORK, 'NO_TRUSTLINE', OPTS);
    await store.raiseAddressAlarm(NETWORK, 'NO_TRUSTLINE', OPTS);
    expect(cannotReceive).toHaveBeenCalledTimes(1);
    expect(cannotReceive).toHaveBeenCalledWith(NETWORK, 'NO_TRUSTLINE', OPTS);
    expect(opened.every((o) => o.session === 'unscoped' && o.arg === 'worker')).toBe(true);
  });

  it('lets a failed alert fail the transaction, so the alarm is not left raised unheard', async () => {
    const { store, cannotReceive } = world();
    const down = new Error('pager down');
    repo.raise.mockResolvedValue(true);
    cannotReceive.mockRejectedValueOnce(down);
    await expect(store.raiseAddressAlarm(NETWORK, 'NO_TRUSTLINE', OPTS)).rejects.toBe(down);
  });

  it('clears the alarm in the worker session', async () => {
    const { store, opened } = world();
    await store.clearAddressAlarm(NETWORK, OPTS);
    expect(repo.clear).toHaveBeenCalledWith('tx', NETWORK);
    expect(opened).toEqual([{ session: 'unscoped', arg: 'worker' }]);
  });

  it('asks the signal before opening anything', async () => {
    const { store, opened } = world();
    const controller = new AbortController();
    controller.abort();
    const opts = { signal: controller.signal };
    const calls = [
      () => store.decideResend(SCOPE, CHAIN_ID, opts),
      () => store.resendDecided(SCOPE, CHAIN_ID, opts),
      () => store.resendWithoutFee(RESEND, opts),
      () => store.raiseAddressAlarm(NETWORK, 'NO_TRUSTLINE', opts),
      () => store.clearAddressAlarm(NETWORK, opts),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow();
    expect(opened).toEqual([]);
  });
});
