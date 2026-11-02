// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import type { NetworksConfig } from '../config.js';
import {
  ActivationBudgetExhaustedError,
  InvalidInputError,
  SponsorDeniedError,
  SponsorUnfundedError,
  UnsupportedError,
} from '../errors.js';
import { withSponsorHealth } from '../health.js';
import { networksConfig } from '../stellar/test-adapter.js';
import { accountFromSeed } from '../testing/address.js';
import { createMemorySponsorshipLedger } from '../testing/sponsorship-ledger.js';
import type {
  ChainHealth,
  NativeAmount,
  SponsoredIntent,
  TenantScope,
  UnixSeconds,
  Uuid,
} from '../types.js';
import { createSponsorshipPolicy, reservationIdOf, sponsorshipReservations } from './policy.js';

const NETWORK = 'stellar:testnet' as const;
const XLM = 10_000_000n;
const scope = (n: number): TenantScope => ({
  principalId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as Uuid,
  projectId: '00000000-0000-4000-9000-000000000001' as Uuid,
});
const A = scope(1);
const B = scope(2);
const fee = (amount: bigint): NativeAmount => ({
  network: NETWORK,
  asset: 'XLM',
  amount,
  scale: 7,
});

type Limits = Partial<NonNullable<NetworksConfig[typeof NETWORK]>['feeSponsor']>;

function world(limits: Limits = {}, activation: object = {}) {
  const base = networksConfig({
    sponsor: accountFromSeed(new Uint8Array(32).fill(1)),
    channel: accountFromSeed(new Uint8Array(32).fill(2)),
  });
  const net = base[NETWORK];
  if (net === undefined) throw new Error('no network');
  const config: NetworksConfig = {
    ...base,
    [NETWORK]: {
      ...net,
      feeSponsor: {
        ...net.feeSponsor,
        perPrincipalPerMinute: 1000,
        perPrincipalDailyCount: 100_000,
        maxFeePerTxStroops: 1000n,
        perPrincipalDailyFeeStroops: 100_000n,
        globalDailyFeeStroops: 200_000n,
        lowBalanceStroops: 100n * XLM,
        minBalanceStroops: 10n * XLM,
        perPrincipalFundingAccounts: 1,
        reserveSponsorshipDailyStroops: 100n * XLM,
        ...limits,
        recipientActivation: { ...net.feeSponsor.recipientActivation, ...activation },
      },
    },
  };
  const t = {
    now: 1_800_000_000n,
    balance: 10_000n * XLM,
    ledger: createMemorySponsorshipLedger(),
    alerts: [] as { balance: NativeAmount; threshold: NativeAmount; account: string }[],
    config,
  };
  const policy = createSponsorshipPolicy({
    ledger: t.ledger,
    config: () => t.config,
    clock: { nowSeconds: () => t.now as UnixSeconds },
    alerts: { lowBalance: (e) => t.alerts.push(e) },
    sponsorBalance: () => Promise.resolve(t.balance),
  });
  return {
    ...t,
    get t() {
      return t;
    },
    policy,
    state: t,
  };
}

let ids = 0;
const reserve = (
  w: ReturnType<typeof world>,
  over: {
    id?: string;
    scope?: TenantScope;
    intent?: SponsoredIntent;
    cost?: bigint;
    activation?: { recipientId: string; account: string };
  } = {},
) => {
  ids += 1;
  return w.policy.reserve({
    scope: over.scope ?? A,
    network: NETWORK,
    reservationId: over.id ?? `id-${String(ids)}`,
    intent: over.intent ?? 'pause',
    maxFee: fee(over.cost ?? 10n),
    ...(over.activation === undefined ? {} : { activation: over.activation }),
  });
};
const activation = (n: number) => ({
  intent: 'recipient_activation' as const,
  cost: 15_000_000n,
  activation: { recipientId: `recipient-${String(n)}`, account: `account-${String(n)}` },
});
const ON = { enabled: true };

describe('the sponsorship policy', { timeout: 30_000 }, () => {
  it('the same envelope reserved twice counts once', async () => {
    const w = world();
    const id = reservationIdOf(NETWORK, new Uint8Array(32).fill(9));
    await reserve(w, { id });
    await reserve(w, { id });
    expect(w.state.ledger.rows).toHaveLength(1);
    expect(await w.state.ledger.totals({ network: NETWORK, since: 0n as UnixSeconds })).toEqual({
      count: 1,
      stroops: 10n,
    });
    // Parallel retries of one envelope count once as well.
    await Promise.all(Array.from({ length: 5 }, () => reserve(w, { id: 'parallel' })));
    expect(w.state.ledger.rows).toHaveLength(2);
  });

  it('keys a reservation by the network and the inner transaction hash', () => {
    const hash = new Uint8Array(32).fill(3);
    expect(reservationIdOf(NETWORK, hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(reservationIdOf('stellar:pubnet', hash)).not.toBe(reservationIdOf(NETWORK, hash));
    expect(reservationIdOf(NETWORK, new Uint8Array(32).fill(4))).not.toBe(
      reservationIdOf(NETWORK, hash),
    );
    expect(() => reservationIdOf(NETWORK, new Uint8Array(31))).toThrow(InvalidInputError);
  });

  it('refuses another tenant reusing a reservation id, and a released one', async () => {
    const w = world();
    await reserve(w, { id: 'mine' });
    await expect(reserve(w, { id: 'mine', scope: B })).rejects.toBeInstanceOf(SponsorDeniedError);
    await w.policy.release({ scope: A, reservationId: 'mine' });
    await expect(reserve(w, { id: 'mine' })).rejects.toBeInstanceOf(SponsorDeniedError);
  });

  it('per minute', async () => {
    const w = world({ perPrincipalPerMinute: 2 });
    await reserve(w);
    await reserve(w);
    await expect(reserve(w)).rejects.toBeInstanceOf(SponsorDeniedError);
    // Another principal has their own count, and the window moves on.
    await reserve(w, { scope: B });
    w.state.now += 60n;
    await reserve(w);
  });

  it('daily count', async () => {
    const w = world({ perPrincipalDailyCount: 2 });
    await reserve(w);
    await reserve(w);
    await expect(reserve(w)).rejects.toBeInstanceOf(SponsorDeniedError);
    await reserve(w, { scope: B });
    w.state.now += 86_400n;
    await reserve(w);
  });

  it('daily fee', async () => {
    const w = world({ perPrincipalDailyFeeStroops: 1000n });
    await reserve(w, { cost: 600n });
    await reserve(w, { cost: 400n });
    await expect(reserve(w, { cost: 1n })).rejects.toBeInstanceOf(SponsorDeniedError);
    await reserve(w, { scope: B, cost: 1000n });
    w.state.now += 86_400n;
    await reserve(w, { cost: 1000n });
  });

  it('global daily fee', async () => {
    const w = world({ perPrincipalDailyFeeStroops: 1000n, globalDailyFeeStroops: 1500n });
    await reserve(w, { cost: 1000n });
    await reserve(w, { scope: B, cost: 500n });
    await expect(reserve(w, { scope: scope(3), cost: 1n })).rejects.toBeInstanceOf(
      SponsorDeniedError,
    );
  });

  it('max fee per tx', async () => {
    const w = world({ maxFeePerTxStroops: 100n });
    await reserve(w, { cost: 100n });
    await expect(reserve(w, { cost: 101n })).rejects.toBeInstanceOf(SponsorDeniedError);
  });

  it('a settled reservation counts what it cost and a released one nothing', async () => {
    const w = world({ perPrincipalDailyFeeStroops: 1000n });
    await reserve(w, { id: 'a', cost: 1000n });
    await expect(reserve(w, { cost: 500n })).rejects.toBeInstanceOf(SponsorDeniedError);
    await w.policy.settle({ scope: A, reservationId: 'a', actualFee: fee(300n) });
    await reserve(w, { id: 'b', cost: 700n });
    await w.policy.release({ scope: A, reservationId: 'b' });
    await reserve(w, { cost: 700n });
    await w.policy.settle({ scope: A, reservationId: 'missing', actualFee: fee(1n) });
  });

  it('holds a limit under parallel reservations', async () => {
    const w = world({ perPrincipalDailyCount: 3 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => reserve(w)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(w.state.ledger.rows).toHaveLength(3);
  });

  it('below min balance gives SPONSOR_UNFUNDED and degraded health', async () => {
    const w = world();
    expect(await w.policy.sponsorFunding(NETWORK)).toBe('funded');
    w.state.balance = 10n * XLM;
    await reserve(w);
    expect(await w.policy.sponsorFunding(NETWORK)).toBe('low');
    w.state.balance = 10n * XLM - 1n;
    await expect(reserve(w)).rejects.toBeInstanceOf(SponsorUnfundedError);
    const funding = await w.policy.sponsorFunding(NETWORK);
    expect(funding).toBe('unfunded');
    const health: Omit<ChainHealth, 'sponsorFunded'> = {
      network: NETWORK,
      state: 'healthy',
      checkedAt: 1n as UnixSeconds,
      headLagSeconds: 0,
      rpcP95Ms: 1,
      submitSuccessRate5m: null,
      executorFunded: true,
      signerHealthy: true,
      rails: [],
      reasons: [],
    };
    expect(withSponsorHealth(health, funding)).toMatchObject({
      state: 'degraded',
      sponsorFunded: false,
      reasons: ['SPONSOR_UNFUNDED'],
    });
    expect(withSponsorHealth({ ...health, state: 'down' }, funding).state).toBe('down');
    expect(
      withSponsorHealth({ ...health, reasons: ['SPONSOR_UNFUNDED'] }, funding).reasons,
    ).toEqual(['SPONSOR_UNFUNDED']);
    // Low still sponsors, so the network stays as it is and says why.
    expect(withSponsorHealth(health, 'low')).toMatchObject({
      state: 'healthy',
      sponsorFunded: true,
      reasons: ['SPONSOR_LOW'],
    });
    expect(withSponsorHealth(health, 'funded')).toMatchObject({ sponsorFunded: true, reasons: [] });
  });

  it('alerts once per drop below the low balance line', async () => {
    const w = world();
    w.state.balance = 100n * XLM;
    await reserve(w);
    expect(w.state.alerts).toHaveLength(0);
    w.state.balance = 100n * XLM - 1n;
    await reserve(w);
    await reserve(w);
    expect(w.state.alerts).toHaveLength(1);
    expect(w.state.alerts[0]).toMatchObject({
      account: 'fee_sponsor',
      balance: { amount: 100n * XLM - 1n },
      threshold: { amount: 100n * XLM },
    });
    w.state.balance = 500n * XLM;
    await reserve(w);
    w.state.balance = XLM * 50n;
    await reserve(w);
    expect(w.state.alerts).toHaveLength(2);
  });

  it("does not count UJIRA's own executor transactions against a principal's limits", async () => {
    const w = world({ perPrincipalPerMinute: 2, perPrincipalDailyCount: 2 });
    for (const reservationId of ['executor-1', 'executor-2', 'executor-3']) {
      await w.policy.book({
        scope: A,
        network: NETWORK,
        reservationId,
        intent: 'executor',
        actualFee: fee(10n),
      });
    }
    await reserve(w);
    await reserve(w);
    await expect(reserve(w)).rejects.toBeInstanceOf(SponsorDeniedError);
  });

  it('refuses a network that is off, and an amount that is not stroops on this network', async () => {
    const w = world();
    const net = w.state.config[NETWORK];
    if (net === undefined) throw new Error('no network');
    await expect(
      w.policy.reserve({
        scope: A,
        network: NETWORK,
        reservationId: 'x',
        intent: 'pause',
        maxFee: { ...fee(1n), scale: 6 as 7 },
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      w.policy.reserve({
        scope: A,
        network: NETWORK,
        reservationId: 'x',
        intent: 'pause',
        maxFee: fee(-1n),
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    w.state.config = { ...w.state.config, [NETWORK]: { ...net, enabled: false } };
    await expect(reserve(w)).rejects.toBeInstanceOf(UnsupportedError);
    await expect(w.policy.sponsorFunding(NETWORK)).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('never lets a tenant reserve as an executor transaction', async () => {
    const w = world();
    await expect(reserve(w, { intent: 'executor' })).rejects.toBeInstanceOf(SponsorDeniedError);
  });

  it('reads the ledger the way the signer asks', async () => {
    const w = world();
    const hash = new Uint8Array(32).fill(5);
    const reader = sponsorshipReservations(w.state.ledger);
    expect(await reader.reserved(NETWORK, hash)).toBeNull();
    await reserve(w, { id: reservationIdOf(NETWORK, hash), cost: 77n });
    expect(await reader.reserved(NETWORK, hash)).toEqual({
      intent: 'fee_bump',
      tenant: A,
      maxFeeStroops: 77n,
    });
    expect(await reader.reserved('stellar:pubnet', hash)).toBeNull();
    await w.policy.settle({
      scope: A,
      reservationId: reservationIdOf(NETWORK, hash),
      actualFee: fee(1n),
    });
    expect(await reader.reserved(NETWORK, hash)).toBeNull();
    const funding = new Uint8Array(32).fill(6);
    await reserve(w, {
      id: reservationIdOf(NETWORK, funding),
      intent: 'create_funding_account',
      cost: XLM,
    });
    expect((await reader.reserved(NETWORK, funding))?.intent).toBe('create_funding_account');
  });
});

describe('recipient activations', { timeout: 30_000 }, () => {
  it('is off unless enabled', async () => {
    const w = world();
    await expect(reserve(w, activation(1))).rejects.toBeInstanceOf(SponsorDeniedError);
    const on = world({}, ON);
    await reserve(on, activation(1));
  });

  it('needs to name what it activates', async () => {
    const w = world({}, ON);
    await expect(reserve(w, { intent: 'recipient_activation', cost: XLM })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it('recipient_activation per-principal cap', async () => {
    const w = world({}, ON);
    for (let n = 0; n < 20; n += 1) await reserve(w, activation(n));
    await expect(reserve(w, activation(20))).rejects.toBeInstanceOf(SponsorDeniedError);
    await reserve(w, { ...activation(21), scope: B });
    w.state.now += 86_400n;
    await reserve(w, activation(22));
  });

  it('network cap', async () => {
    const w = world({}, { ...ON, dailyStroops: 150n * XLM, perPrincipalDaily: 1000 });
    const each = 15_000_000n;
    for (let n = 0; n < 100; n += 1) {
      await reserve(w, { ...activation(n), scope: scope(n % 7), cost: each });
    }
    await expect(reserve(w, { ...activation(100), cost: 1n })).rejects.toBeInstanceOf(
      SponsorDeniedError,
    );
  });

  it('floor', async () => {
    const w = world({}, ON);
    w.state.balance = 510n * XLM;
    await reserve(w, activation(1));
    w.state.balance = 510n * XLM - 1n;
    await expect(reserve(w, activation(2))).rejects.toBeInstanceOf(SponsorUnfundedError);
    // An ordinary fee is still sponsored at that balance.
    await reserve(w);
  });

  it('activates one recipient per network and one account ever', async () => {
    const w = world({}, ON);
    await reserve(w, activation(1));
    const { activation: key } = activation(1);
    await expect(
      reserve(w, {
        ...activation(2),
        activation: { recipientId: key.recipientId, account: 'new' },
      }),
    ).rejects.toBeInstanceOf(SponsorDeniedError);
    await expect(
      reserve(w, { ...activation(2), activation: { recipientId: 'new', account: key.account } }),
    ).rejects.toBeInstanceOf(SponsorDeniedError);
  });

  it('activations past 300 XLM in a month for one principal give ACTIVATION_BUDGET_EXHAUSTED, funding accounts count, and the budget resets next month', async () => {
    const w = world(
      { perPrincipalFundingAccounts: 1, reserveSponsorshipDailyStroops: 1000n * XLM },
      { ...ON, perPrincipalDaily: 1000, dailyStroops: 10_000n * XLM },
    );
    // 2027-01-31: the last day of a month, so the next day is a new budget.
    w.state.now = 1_801_353_600n;
    await reserve(w, { intent: 'create_funding_account', cost: 100n * XLM });
    await reserve(w, { ...activation(1), cost: 199n * XLM });
    await reserve(w, { ...activation(2), cost: XLM });
    const over = reserve(w, { ...activation(3), cost: 1n });
    await expect(over).rejects.toBeInstanceOf(ActivationBudgetExhaustedError);
    await expect(over).rejects.toMatchObject({
      code: 'ACTIVATION_BUDGET_EXHAUSTED',
      retryable: false,
    });
    // Another principal, and an ordinary fee, are untouched.
    await reserve(w, { ...activation(4), scope: B, cost: XLM });
    await reserve(w);
    w.state.now += 86_400n;
    await reserve(w, { ...activation(5), cost: 300n * XLM });
  });
});

describe('funding accounts', { timeout: 30_000 }, () => {
  it('holds the per principal count and the daily reserve', async () => {
    const w = world({ perPrincipalFundingAccounts: 1, reserveSponsorshipDailyStroops: 15n * XLM });
    const account = { intent: 'create_funding_account' as const, cost: 10n * XLM };
    await reserve(w, account);
    await expect(reserve(w, account)).rejects.toBeInstanceOf(SponsorDeniedError);
    await expect(reserve(w, { ...account, scope: B })).rejects.toBeInstanceOf(SponsorDeniedError);
    await reserve(w, { ...account, scope: scope(3), cost: 5n * XLM });
  });
});
