// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Principals never need XLM, so UJIRA pays, and this is what keeps that from
// being a way to drain the fee account. Every limit is read from the ledger,
// inside the same atomic section as the row it guards. A reservation is keyed
// by the transaction it pays for, so a retried envelope cannot count twice.

import { createHash } from 'node:crypto';

import type { StellarNetworkConfig, NetworksConfig } from '../config.js';
import {
  ActivationBudgetExhaustedError,
  InvalidInputError,
  SponsorDeniedError,
  SponsorUnfundedError,
  UnsupportedError,
} from '../errors.js';
import type { NetworkId } from '../networks.js';
import type {
  AdapterAlerts,
  NativeAmount,
  SponsoredIntent,
  SponsorshipPolicy,
  UnixSeconds,
} from '../types.js';
import type { ActivationKey, SponsorshipLedger } from './ledger.js';

const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_DAY = 86_400n;

// These leave XLM locked as a reserve rather than burn a fee, so the fee
// counters do not fit them and they have budgets of their own.
const RESERVE_INTENTS: readonly SponsoredIntent[] = [
  'create_funding_account',
  'recipient_activation',
];
const NOT_A_FEE: ReadonlySet<SponsoredIntent> = new Set([...RESERVE_INTENTS, 'executor']);
const SPONSOR_FEE_INTENTS: readonly SponsoredIntent[] = [
  'fund',
  'create_mandate',
  'pause',
  'resume',
  'revoke',
  'approve',
  'reject',
  'cancel',
  'withdraw',
  'admin',
  'trustline',
];

// What a principal's rate limits count. UJIRA's own executor transactions are
// in the ledger too, and must not use up the limits of the tenant they serve.
const PRINCIPAL_INTENTS: readonly SponsoredIntent[] = [...SPONSOR_FEE_INTENTS, ...RESERVE_INTENTS];

export type SponsorFunding = 'funded' | 'low' | 'unfunded';

export interface SponsorshipPolicyOptions {
  readonly ledger: SponsorshipLedger;
  readonly config: () => NetworksConfig;
  readonly clock: { nowSeconds(): UnixSeconds };
  readonly alerts: Pick<AdapterAlerts, 'lowBalance'>;
  /** The fee sponsor's balance in stroops, read fresh. */
  sponsorBalance(network: NetworkId): Promise<bigint>;
}

export interface ManagedSponsorshipPolicy extends SponsorshipPolicy {
  /** Where the fee sponsor's balance stands against its thresholds, for network health. */
  sponsorFunding(network: NetworkId): Promise<SponsorFunding>;
}

/** The reservation for a transaction: SHA-256 over the network and the inner transaction's hash. */
export function reservationIdOf(network: NetworkId, innerTxHash: Uint8Array): string {
  if (!(innerTxHash instanceof Uint8Array) || innerTxHash.length !== 32) {
    throw new InvalidInputError({ network, issues: ['innerTxHash (invalid)'] });
  }
  // The hash has a fixed width and comes last, so no two inputs share bytes.
  return createHash('sha256').update(network, 'utf8').update(innerTxHash).digest('hex');
}

function dayStart(now: UnixSeconds): UnixSeconds {
  return (now - (now % SECONDS_PER_DAY)) as UnixSeconds;
}

function monthStart(now: UnixSeconds): UnixSeconds {
  const date = new Date(Number(now) * 1000);
  return BigInt(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000) as UnixSeconds;
}

function stroopsOf(network: NetworkId, amount: NativeAmount, field: string): bigint {
  // Typed as XLM at scale 7, checked anyway: this is what stands between a
  // caller's mistake and a limit counted in the wrong unit.
  const { asset, scale } = amount as { readonly asset: unknown; readonly scale: unknown };
  if (
    amount.network !== network ||
    asset !== 'XLM' ||
    scale !== 7 ||
    typeof amount.amount !== 'bigint' ||
    amount.amount < 0n
  ) {
    throw new InvalidInputError({ network, issues: [`${field} (invalid)`] });
  }
  return amount.amount;
}

export function createSponsorshipPolicy(
  options: SponsorshipPolicyOptions,
): ManagedSponsorshipPolicy {
  const { ledger, clock, alerts } = options;
  const alerted = new Set<NetworkId>();

  const networkConfig = (network: NetworkId): StellarNetworkConfig => {
    const config = options.config()[network];
    if (!config?.enabled) throw new UnsupportedError({ network });
    return config;
  };

  // Tells operations once per drop below the line, not on every reservation,
  // and again only after the account has been topped up and fallen back.
  const checkBalance = async (network: NetworkId): Promise<bigint> => {
    const { lowBalanceStroops, minBalanceStroops } = networkConfig(network).feeSponsor;
    const balance = await options.sponsorBalance(network);
    if (balance >= lowBalanceStroops) {
      alerted.delete(network);
    } else if (!alerted.has(network)) {
      alerted.add(network);
      alerts.lowBalance({
        network,
        account: 'fee_sponsor',
        balance: { network, asset: 'XLM', amount: balance, scale: 7 },
        threshold: { network, asset: 'XLM', amount: lowBalanceStroops, scale: 7 },
      });
    }
    if (balance < minBalanceStroops) throw new SponsorUnfundedError({ network });
    return balance;
  };

  const checkActivation = async (
    network: NetworkId,
    principalId: string,
    key: ActivationKey | undefined,
    cost: bigint,
    balance: bigint,
    now: UnixSeconds,
  ): Promise<void> => {
    const { recipientActivation: limits, minBalanceStroops } = networkConfig(network).feeSponsor;
    if (!limits.enabled) throw new SponsorDeniedError({ network });
    if (key === undefined)
      throw new InvalidInputError({ network, issues: ['activation (required)'] });
    if (balance < minBalanceStroops + limits.floorStroops) {
      throw new SponsorUnfundedError({ network });
    }
    if (await ledger.activationExists(network, key)) throw new SponsorDeniedError({ network });
    const today = dayStart(now);
    const intents: readonly SponsoredIntent[] = ['recipient_activation'];
    const mine = await ledger.totals({ network, since: today, principalId, intents });
    if (mine.count >= limits.perPrincipalDaily) throw new SponsorDeniedError({ network });
    const everyone = await ledger.totals({ network, since: today, intents });
    if (everyone.stroops + cost > limits.dailyStroops) throw new SponsorDeniedError({ network });
  };

  const checkFundingAccount = async (
    network: NetworkId,
    principalId: string,
    cost: bigint,
    now: UnixSeconds,
  ): Promise<void> => {
    const limits = networkConfig(network).feeSponsor;
    const intents: readonly SponsoredIntent[] = ['create_funding_account'];
    const ever = await ledger.totals({ network, since: 0n as UnixSeconds, principalId, intents });
    if (ever.count >= limits.perPrincipalFundingAccounts) throw new SponsorDeniedError({ network });
    const today = await ledger.totals({ network, since: dayStart(now), intents });
    if (today.stroops + cost > limits.reserveSponsorshipDailyStroops) {
      throw new SponsorDeniedError({ network });
    }
  };

  const checkFee = async (
    network: NetworkId,
    principalId: string,
    cost: bigint,
    now: UnixSeconds,
  ): Promise<void> => {
    const limits = networkConfig(network).feeSponsor;
    if (cost > limits.maxFeePerTxStroops) throw new SponsorDeniedError({ network });
    const since = dayStart(now);
    const intents = SPONSOR_FEE_INTENTS;
    const mine = await ledger.totals({ network, since, principalId, intents });
    if (mine.stroops + cost > limits.perPrincipalDailyFeeStroops) {
      throw new SponsorDeniedError({ network });
    }
    const everyone = await ledger.totals({ network, since, intents });
    if (everyone.stroops + cost > limits.globalDailyFeeStroops) {
      throw new SponsorDeniedError({ network });
    }
  };

  return {
    async reserve(r) {
      const { network, scope, reservationId, intent } = r;
      const cost = stroopsOf(network, r.maxFee, 'maxFee');
      networkConfig(network);
      const known = async (): Promise<boolean> => {
        const row = await ledger.get(reservationId);
        if (row === null) return false;
        // The same transaction asked again counts once. A released one was
        // refused or abandoned, and another tenant's is never this tenant's.
        if (
          row.network !== network ||
          row.state === 'released' ||
          row.scope.principalId !== scope.principalId ||
          row.scope.projectId !== scope.projectId
        ) {
          throw new SponsorDeniedError({ network });
        }
        return true;
      };
      if (await known()) return;
      // Read outside the atomic section, which must not wait on a network.
      const balance = await checkBalance(network);
      await ledger.atomically(network, async () => {
        if (await known()) return;
        const now = clock.nowSeconds();
        const limits = networkConfig(network).feeSponsor;
        const principalId = scope.principalId;
        const recent = await ledger.totals({
          network,
          since: (now - SECONDS_PER_MINUTE + 1n) as UnixSeconds,
          principalId,
          intents: PRINCIPAL_INTENTS,
        });
        if (recent.count >= limits.perPrincipalPerMinute) throw new SponsorDeniedError({ network });
        const daily = await ledger.totals({
          network,
          since: dayStart(now),
          principalId,
          intents: PRINCIPAL_INTENTS,
        });
        if (daily.count >= limits.perPrincipalDailyCount) throw new SponsorDeniedError({ network });

        if (intent === 'recipient_activation') {
          await checkActivation(network, principalId, r.activation, cost, balance, now);
        } else if (intent === 'create_funding_account') {
          await checkFundingAccount(network, principalId, cost, now);
        } else if (NOT_A_FEE.has(intent)) {
          // UJIRA's own transactions are booked, never reserved by a tenant.
          throw new SponsorDeniedError({ network });
        } else {
          await checkFee(network, principalId, cost, now);
        }
        if (NOT_A_FEE.has(intent)) {
          const month = await ledger.totals({
            network,
            since: monthStart(now),
            principalId,
            intents: RESERVE_INTENTS,
          });
          const budget = limits.recipientActivation.perPrincipalMonthlyStroops;
          if (month.stroops + cost > budget) throw new ActivationBudgetExhaustedError({ network });
        }
        await ledger.insert({
          reservationId,
          scope,
          network,
          intent,
          state: 'reserved',
          maxFeeStroops: cost,
          actualFeeStroops: null,
          rentStroops: null,
          reservedAt: now,
          activation: r.activation ?? null,
        });
      });
    },

    async settle(r) {
      const row = await ledger.get(r.reservationId);
      if (row === null) return;
      await ledger.settle(
        r.scope,
        r.reservationId,
        stroopsOf(row.network, r.actualFee, 'actualFee'),
        r.rent === undefined ? null : stroopsOf(row.network, r.rent, 'rent'),
      );
    },

    release(r) {
      return ledger.release(r.scope, r.reservationId);
    },

    async book(r) {
      const actual = stroopsOf(r.network, r.actualFee, 'actualFee');
      await ledger.insert({
        reservationId: r.reservationId,
        scope: r.scope,
        network: r.network,
        intent: r.intent,
        state: 'settled',
        maxFeeStroops: actual,
        actualFeeStroops: actual,
        rentStroops: r.rent === undefined ? null : stroopsOf(r.network, r.rent, 'rent'),
        reservedAt: clock.nowSeconds(),
        activation: null,
      });
    },

    async sponsorFunding(network) {
      const { lowBalanceStroops, minBalanceStroops } = networkConfig(network).feeSponsor;
      const balance = await options.sponsorBalance(network);
      if (balance < minBalanceStroops) return 'unfunded';
      return balance < lowBalanceStroops ? 'low' : 'funded';
    },
  };
}

/** The UTC month of a time, as the uncovered cost counter keys it. */
export function monthOf(now: UnixSeconds): string {
  return new Date(Number(now) * 1000).toISOString().slice(0, 7);
}

/**
 * The month's network cost the take did not cover. Counted per network and
 * reset by the month in its key, so nothing has to run at the boundary.
 */
export function createUncoveredBudget(options: {
  readonly ledger: Pick<SponsorshipLedger, 'addShortfall' | 'shortfall'>;
  readonly config: () => NetworksConfig;
  readonly clock: { nowSeconds(): UnixSeconds };
}) {
  const { ledger, clock } = options;
  const budgetOf = (network: NetworkId): bigint => {
    const config = options.config()[network];
    if (config === undefined) throw new UnsupportedError({ network });
    return config.fees.uncoveredNetworkCost.monthlyBudgetStroops;
  };
  return {
    /** Adds a shortfall and returns the month's total. */
    record(network: NetworkId, stroops: bigint): Promise<bigint> {
      if (typeof stroops !== 'bigint' || stroops < 0n) {
        throw new InvalidInputError({ network, issues: ['stroops (invalid)'] });
      }
      return ledger.addShortfall(network, monthOf(clock.nowSeconds()), stroops);
    },
    spent(network: NetworkId): Promise<bigint> {
      return ledger.shortfall(network, monthOf(clock.nowSeconds()));
    },
    /** What the minimum check reads: whether the month still absorbs a shortfall of this size. */
    async covers(network: NetworkId, stroops: bigint): Promise<boolean> {
      const spent = await ledger.shortfall(network, monthOf(clock.nowSeconds()));
      return spent + stroops <= budgetOf(network);
    },
  };
}

/** The ledger as the signer service reads it before the sponsor signs. */
export function sponsorshipReservations(ledger: Pick<SponsorshipLedger, 'get'>) {
  return {
    async reserved(network: NetworkId, txHash: Uint8Array) {
      const row = await ledger.get(reservationIdOf(network, txHash));
      if (row?.state !== 'reserved' || row.network !== network) return null;
      const intent: 'fee_bump' | 'create_funding_account' | 'recipient_activation' =
        row.intent === 'create_funding_account' || row.intent === 'recipient_activation'
          ? row.intent
          : 'fee_bump';
      return { intent, tenant: row.scope, maxFeeStroops: row.maxFeeStroops };
    },
  };
}
