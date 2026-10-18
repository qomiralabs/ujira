// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Deterministic fixtures for every read schema. The same seed always gives
// the same data. Amounts are built with the core money model (allocation,
// conversion, the fee cap) so the fixtures obey the same arithmetic as the
// ledger. Names, addresses and hashes are visibly synthetic: no fixture can
// be mistaken for a real person, account or key.

import {
  I128_MAX,
  SETTLEMENT_TOKENS,
  allocate,
  convertMoney,
  money,
  parseRate,
  subtract,
  tokenAmount,
  usdToToken,
} from '@ujira/core';
import type { FiatCurrencyCode, Money as CoreMoney, TokenAmount as CoreToken } from '@ujira/core';

import type { ApprovalItem } from '../approvals.js';
import { NETWORK_IDS } from '../common.js';
import type { NetworkId, TenantScope } from '../common.js';
import {
  ALLOWED_BY,
  ALLOWED_PAYOUT_STATUSES,
  DEPOSIT_STATUSES,
  MANDATE_STATUSES,
  PAYOUT_METHODS,
  PAYOUT_STATUSES,
  RECIPIENT_MODES,
} from '../enums.js';
import type {
  AllowedBy,
  LegStatus,
  MandateInstanceStatus,
  MandateStatus,
  PayoutMethod,
  PayoutStatus,
  RecipientMode,
} from '../enums.js';
import type { Deposit, FundingOverview } from '../funding.js';
import { DEFAULT_LOW_BALANCE } from '../low-balance.js';
import type { LowBalance } from '../low-balance.js';
import type { MandateDetail, MandateListItem } from '../mandates.js';
import { toWireMoney, toWireToken } from '../money.js';
import type { Money, TokenAmount } from '../money.js';
import type { PayoutDetail, PayoutLeg, PayoutListItem } from '../payouts.js';
import { DEFAULT_RECEIPT_SETTINGS } from '../receipts.js';
import type {
  PrincipalReceipt,
  ReceiptListItem,
  ReceiptSettings,
  RecipientReceipt,
} from '../receipts.js';
import { Rng } from './rng.js';

export interface FixtureOptions {
  readonly seed: number;
  /** Total payouts across every tenant. Defaults to 120. */
  readonly payouts?: number;
  /**
   * Adds the edge cases: every status and method, right to left and long
   * names, several dollar currencies, zero and maximum amounts.
   */
  readonly edge?: boolean;
}

export interface FixtureTenant extends TenantScope {
  readonly principalName: string;
  readonly projectName: string;
  readonly network: NetworkId;
  readonly receiptSettings: ReceiptSettings;
  readonly cashOutBearer: 'recipient' | 'principal';
}

export interface FixtureRecipient {
  readonly id: string;
  readonly displayName: string;
  readonly country: string | null;
  readonly mainMethod: PayoutMethod;
}

export interface FixtureSet {
  readonly seed: number;
  readonly tenants: readonly FixtureTenant[];
  readonly mandates: readonly MandateDetail[];
  readonly payouts: readonly PayoutDetail[];
  readonly receipts: readonly PrincipalReceipt[];
  /** The recipient view of each receipt, in the same order as `receipts`. */
  readonly recipientReceipts: readonly RecipientReceipt[];
  readonly funding: readonly FundingOverview[];
  readonly deposits: readonly Deposit[];
  readonly approvals: readonly ApprovalItem[];
  /** Which low-balance case each mandate instance was built for. */
  readonly lowBalanceCases: ReadonlyMap<string, LowBalanceCase>;
}

const BASE_TIME = Date.parse('2026-09-01T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function settlementTokenOrThrow(): (typeof SETTLEMENT_TOKENS)[number] {
  const found = SETTLEMENT_TOKENS[0];
  if (found === undefined) throw new RangeError('no settlement token is configured');
  return found;
}
const TOKEN = settlementTokenOrThrow();

// Countries with a currency in the core table, so local legs can be priced.
const LOCAL_CURRENCY: readonly (readonly [string, FiatCurrencyCode, string])[] = [
  ['NG', 'NGN', '1600.25'],
  ['KE', 'KES', '129.40'],
  ['GH', 'GHS', '15.80'],
  ['ZA', 'ZAR', '18.05'],
  ['PH', 'PHP', '57.35'],
  ['IN', 'INR', '84.10'],
  ['BR', 'BRL', '5.42'],
  ['CO', 'COP', '4012.5'],
  ['MX', 'MXN', '19.72'],
];

// Edge names: very long, and right to left in two scripts, to stress
// truncation and bidirectional layout. None of them is a person's name.
export const EDGE_NAMES = Object.freeze({
  long: `Fixture Recipient With A Deliberately Long Display Name ${'For Truncation Testing '.repeat(5).trim()}`,
  arabic: 'مستلم تجريبي رقم ١٢',
  hebrew: 'נמען לדוגמה מספר 7',
  mixed: 'Fixture مستلم 0042',
});

const iso = (ms: number): string => new Date(ms).toISOString();

function fakeAddress(prefix: 'G' | 'C', label: string, n: number): string {
  const body = `FIXTURE${label}`.toUpperCase().replace(/[^A-Z]/g, 'X');
  const tail = String(n).padStart(6, '0');
  return `${prefix}${body.padEnd(55 - tail.length, 'X')}${tail}`;
}

// Hashes start with sixteen zeros, which no real transaction will.
const fakeHash = (rng: Rng): string => `0000000000000000${rng.hex(48)}`;

const receiptNumber = (rng: Rng): string => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = 'R-';
  for (let i = 0; i < 12; i += 1) out += alphabet[rng.below(alphabet.length)] ?? '0';
  return out;
};

const wire = (value: CoreMoney): Money => toWireMoney(value);

function token(amount: bigint, network: NetworkId): TokenAmount {
  return toWireToken(tokenAmount(amount, TOKEN.asset, TOKEN.chain), network);
}

function core(value: TokenAmount): CoreToken {
  return tokenAmount(value.amount, TOKEN.asset, TOKEN.chain);
}

/** The contract's fee cap at a rate, which is what the take is set to. */
function takeAt(total: bigint, bps: number): bigint {
  const b = BigInt(bps);
  return (total / 10000n) * b + ((total % 10000n) * b) / 10000n;
}

const ALLOWED_PREFIX: Readonly<Record<RecipientMode, string>> = Object.freeze({
  allowlist: 'allowlist',
  attested: 'attestation',
  both: 'allowlist_and_attestation',
});

function allowedByFor(mode: RecipientMode, approved: boolean): AllowedBy {
  return `${ALLOWED_PREFIX[mode]}_${approved ? 'approved' : 'auto'}` as AllowedBy;
}

function modeOf(allowedBy: AllowedBy): RecipientMode {
  const found = RECIPIENT_MODES.find(
    (mode) => allowedBy.replace(/_(auto|approved)$/, '') === ALLOWED_PREFIX[mode],
  );
  if (found === undefined) throw new RangeError('unknown allowedBy');
  return found;
}

function instanceStatusFor(status: MandateStatus, rng: Rng): MandateInstanceStatus {
  if (status === 'draft') return rng.chance(70) ? 'deploying' : 'deploy_failed';
  return status;
}

/** The low-balance situations the fixtures cover, one per deployed mandate in turn. */
export const LOW_BALANCE_CASES = Object.freeze([
  'both',
  'runway',
  'fixed',
  'fallback',
  'none',
] as const);
export type LowBalanceCase = (typeof LOW_BALANCE_CASES)[number];

interface Forced {
  readonly method?: PayoutMethod;
  readonly currency?: FiatCurrencyCode;
  readonly allowedBy?: AllowedBy;
}

class Builder {
  private readonly rng: Rng;
  private readonly edge: boolean;
  readonly tenants: FixtureTenant[] = [];
  readonly recipients = new Map<string, FixtureRecipient[]>();
  readonly mandates: MandateDetail[] = [];
  readonly payouts: PayoutDetail[] = [];
  readonly receipts: PrincipalReceipt[] = [];
  readonly recipientReceipts: RecipientReceipt[] = [];
  readonly deposits: Deposit[] = [];
  readonly approvals: ApprovalItem[] = [];
  readonly funding: FundingOverview[] = [];
  private addressCounter = 0;
  private deployed = 0;
  readonly lowBalanceCase = new Map<string, LowBalanceCase>();

  constructor(seed: number, edge: boolean) {
    this.rng = new Rng(seed);
    this.edge = edge;
  }

  private address(prefix: 'G' | 'C', label: string): string {
    this.addressCounter += 1;
    return fakeAddress(prefix, label, this.addressCounter);
  }

  buildTenants(): void {
    const principalA = this.rng.uuid();
    const principalB = this.rng.uuid();
    const testnet = NETWORK_IDS[1];
    const pubnet = NETWORK_IDS[0];
    this.tenants.push(
      {
        principalId: principalA,
        projectId: this.rng.uuid(),
        principalName: 'Fixture Labs Test Principal',
        projectName: 'Fixture Project Payroll',
        network: testnet,
        receiptSettings: { ...DEFAULT_RECEIPT_SETTINGS },
        cashOutBearer: 'recipient',
      },
      {
        principalId: principalA,
        projectId: this.rng.uuid(),
        principalName: 'Fixture Labs Test Principal',
        projectName: 'Fixture Project Bounties',
        network: this.edge ? pubnet : testnet,
        receiptSettings: { ...DEFAULT_RECEIPT_SETTINGS },
        cashOutBearer: 'principal',
      },
      {
        principalId: principalB,
        projectId: this.rng.uuid(),
        principalName: 'Second Fixture Principal',
        projectName: 'Fixture Project Default',
        network: testnet,
        // Turned off, so both receipt variants exist.
        receiptSettings: { showPayerName: false },
        cashOutBearer: 'recipient',
      },
    );
  }

  buildRecipients(tenant: FixtureTenant, index: number): void {
    const list: FixtureRecipient[] = [];
    const count = 24;
    const edgeNames = Object.values(EDGE_NAMES);
    for (let i = 0; i < count; i += 1) {
      const local = LOCAL_CURRENCY[(i + index) % LOCAL_CURRENCY.length];
      const walletOnly = i % 5 === 4;
      const name =
        this.edge && i < edgeNames.length
          ? (edgeNames[i] ?? '')
          : `Fixture Recipient ${String(index + 1)}-${String(i + 1).padStart(3, '0')}`;
      list.push({
        id: this.rng.uuid(),
        displayName: name,
        // One recipient with no country on file, which the schema allows.
        country: i === count - 1 ? null : (local?.[0] ?? null),
        mainMethod:
          walletOnly || i === count - 1 ? 'stellar_wallet' : this.rng.pick(PAYOUT_METHODS),
      });
    }
    this.recipients.set(tenant.projectId, list);
  }

  buildMandate(
    tenant: FixtureTenant,
    status: MandateStatus,
    mode: RecipientMode,
    n: number,
    extreme: 'none' | 'zero' | 'max',
  ): void {
    const rng = this.rng;
    const created = BASE_TIME - (30 + rng.below(60)) * DAY;
    const total = extreme === 'max' ? I128_MAX : BigInt(rng.between(5, 500) * 100_000);
    const totalUsd = money(total, 'USD');
    const perPayment = extreme === 'max' ? I128_MAX : total / 10n;
    const threshold = extreme === 'zero' ? 0n : total / 50n;
    // The budget is the USD limit at par in the token, except at the maximum,
    // where the token side sits at the i128 bound on its own.
    const budgetTotal =
      extreme === 'max' ? I128_MAX : usdToToken(totalUsd, TOKEN.asset, TOKEN.chain).amount;
    const used = extreme === 'none' ? rng.bigBetween(0n, budgetTotal / 2n) : 0n;
    const committed = extreme === 'none' ? rng.bigBetween(0n, (budgetTotal - used) / 3n) : 0n;
    const instanceStatus = instanceStatusFor(status, rng);
    const deployed = instanceStatus !== 'deploying' && instanceStatus !== 'deploy_failed';
    const instanceId = rng.uuid();
    const approvalsRequired = rng.between(1, 3);
    const countries = [
      ...new Set(LOCAL_CURRENCY.slice(0, rng.between(1, 6)).map(([c]) => c)),
    ].sort();
    // Deployed mandates take the low-balance cases in turn, so each case
    // shows up on the funding page.
    const lowCase: LowBalanceCase = deployed
      ? (LOW_BALANCE_CASES[this.deployed++ % LOW_BALANCE_CASES.length] ?? 'none')
      : 'none';
    const fixed = token(BigInt(rng.between(100, 5_000)) * 10_000_000n, tenant.network);
    const lowBalance: LowBalance =
      lowCase === 'both'
        ? { runwayDays: 7, fixed }
        : lowCase === 'fixed'
          ? { runwayDays: null, fixed }
          : { ...DEFAULT_LOW_BALANCE };
    this.lowBalanceCase.set(instanceId, lowCase);
    this.mandates.push({
      principalId: tenant.principalId,
      projectId: tenant.projectId,
      id: rng.uuid(),
      name: `Fixture Mandate ${String(n + 1).padStart(2, '0')}`,
      status,
      recipientMode: mode,
      limits: {
        totalBudget: wire(totalUsd),
        perPaymentCap: wire(money(perPayment, 'USD')),
        perRecipientDailyCap: wire(money(perPayment, 'USD')),
        approvalThreshold: wire(money(threshold, 'USD')),
      },
      expiresAt: iso(BASE_TIME + (90 + rng.below(200)) * DAY),
      createdAt: iso(created),
      updatedAt: iso(created + rng.below(20) * DAY),
      countryPolicy: { mode: n % 3 === 2 ? 'block' : 'allow', countries },
      countryPolicyHash: rng.hex(64),
      // One mandate whose stored list no longer matches the chain, in the edge set.
      countryPolicyHashMatches: !(this.edge && n === 1),
      lowBalance,
      instances: [
        {
          id: instanceId,
          network: tenant.network,
          asset: 'USDC',
          status: instanceStatus,
          budget: {
            total: token(budgetTotal, tenant.network),
            used: token(used, tenant.network),
            committed: token(committed, tenant.network),
            remaining: token(budgetTotal - used - committed, tenant.network),
          },
          specVersion: 1,
          fundingAddress: deployed ? this.address('C', 'MANDATE') : null,
          roles: [
            { role: 'agent', address: this.address('G', 'AGENT'), memberId: null },
            ...Array.from({ length: approvalsRequired }, () => ({
              role: 'approver' as const,
              address: this.address('G', 'APPROVER'),
              memberId: rng.uuid(),
            })),
            { role: 'guardian', address: this.address('G', 'GUARDIAN'), memberId: null },
            { role: 'executor', address: this.address('G', 'EXECUTOR'), memberId: null },
            { role: 'recovery', address: this.address('G', 'RECOVERY'), memberId: rng.uuid() },
          ],
          approvalsRequired,
          maxFeeBps: 100,
          payoutTtlSeconds: 7 * 86400,
          policyEpoch: rng.below(4),
          expiresAt: iso(BASE_TIME + 365 * DAY),
        },
      ],
    });
  }

  private localLeg(
    tenant: FixtureTenant,
    recipient: FixtureRecipient,
    method: PayoutMethod,
    amount: CoreToken,
    status: LegStatus,
    index: number,
    times: { settled: number | null; delivered: number | null },
  ): PayoutLeg {
    const rng = this.rng;
    const wallet = method === 'stellar_wallet';
    const settled = ['settled', 'delivering', 'delivered'].includes(status);
    const base = {
      id: rng.uuid(),
      index,
      method,
      rail: wallet ? ('stellar.wallet' as const) : ('stellar.sep31' as const),
      status,
      amount: toWireToken(amount, tenant.network),
      txHash: settled ? fakeHash(rng) : null,
      failureReason: status === 'failed' ? rng.pick(['refunded', 'expired', 'anchor_error']) : null,
      replacesLegId: null,
      settledAt: settled && times.settled !== null ? iso(times.settled) : null,
      deliveredAt: status === 'delivered' && times.delivered !== null ? iso(times.delivered) : null,
    };
    if (wallet) {
      return {
        ...base,
        received: null,
        maskedDestination: `G...${rng.hex(4).toUpperCase()}`,
        anchorName: null,
        cashOut: null,
        anchorTransactionId: null,
      };
    }
    const local = LOCAL_CURRENCY.find(([c]) => c === recipient.country) ?? LOCAL_CURRENCY[0];
    const [country, currency, rateText] = local ?? ['NG', 'NGN', '1600.25'];
    const rate = parseRate(rateText, { base: 'USDC', quote: currency });
    // A small fee; the zero fee case is kept for the edge set.
    const fee = tokenAmount(
      this.edge && index === 0 && rng.chance(5) ? 0n : amount.amount / 100n,
      'USDC',
      amount.chain,
    );
    const sent = tenant.cashOutBearer === 'recipient' ? subtract(amount, fee) : amount;
    return {
      ...base,
      received: wire(convertMoney(sent, rate, { currency }, 'floor')),
      maskedDestination: `****${String(rng.between(1000, 9999))}`,
      anchorName: `Fixture Anchor ${country}`,
      cashOut: {
        bearer: tenant.cashOutBearer,
        anchorFee: toWireToken(fee, tenant.network),
        rate: { rate: rateText, base: 'USDC', quote: currency },
      },
      anchorTransactionId: settled ? `fixture-anchor-tx-${rng.hex(12)}` : null,
    };
  }

  payoutStatus(): PayoutStatus {
    // Mostly paid, as a real table is, with every other status present.
    return this.rng.chance(45) ? 'paid' : this.rng.pick(PAYOUT_STATUSES);
  }

  buildPayout(tenant: FixtureTenant, status: PayoutStatus, index: number, forced: Forced): void {
    const rng = this.rng;
    const recipients = this.recipients.get(tenant.projectId) ?? [];
    const recipient = recipients[index % recipients.length] ?? recipients[0];
    const mandates = this.mandates.filter(
      (m) => m.projectId === tenant.projectId && m.status !== 'draft',
    );
    const wanted = forced.allowedBy === undefined ? undefined : modeOf(forced.allowedBy);
    const mandate =
      (wanted === undefined ? undefined : mandates.find((m) => m.recipientMode === wanted)) ??
      mandates[index % Math.max(mandates.length, 1)];
    const instance = mandate?.instances[0];
    if (recipient === undefined || mandate === undefined || instance === undefined) return;

    const created = BASE_TIME + index * 37_000 + rng.below(30_000);
    const routed =
      !['queued', 'failed'].includes(status) &&
      !(status === 'cancelled' && rng.chance(40)) &&
      !(status === 'blocked' && rng.chance(50));
    const currency: FiatCurrencyCode =
      forced.currency ??
      (tenant === this.tenants[0] ? rng.pick(['USD', 'USD', 'COP', 'MXN'] as const) : 'USD');
    const requestedMinor =
      this.edge && index % 997 === 5 ? I128_MAX : BigInt(rng.between(100, 500_000));
    const requested = money(requestedMinor, currency);

    const settlementAmount = BigInt(rng.between(100, 500_000)) * 100_000n;
    const settlement = routed ? tokenAmount(settlementAmount, TOKEN.asset, TOKEN.chain) : null;

    // Settling means every leg is a wallet leg; delivering needs an anchor leg.
    const method: PayoutMethod =
      status === 'settling'
        ? 'stellar_wallet'
        : status === 'delivering'
          ? 'bank'
          : (forced.method ?? (routed ? rng.pick(PAYOUT_METHODS) : recipient.mainMethod));
    const split =
      settlement !== null &&
      (status === 'partly_paid' || (status !== 'settling' && rng.chance(20)));
    const secondMethod: PayoutMethod = method === 'stellar_wallet' ? 'bank' : 'stellar_wallet';

    const approvalsRequired = instance.approvalsRequired;
    const needsApproval = status === 'pending_approval' || rng.chance(30);
    const allowed =
      ALLOWED_PAYOUT_STATUSES.has(status) || (status === 'cancelled' && routed && rng.chance(50));
    const allowedBy: AllowedBy | null = allowed
      ? (forced.allowedBy ?? allowedByFor(mandate.recipientMode, needsApproval))
      : null;
    const approvedViaApprovers = allowedBy?.endsWith('_approved') ?? false;
    const approvals =
      status === 'pending_approval'
        ? { given: rng.below(approvalsRequired), required: approvalsRequired }
        : approvedViaApprovers
          ? { given: approvalsRequired, required: approvalsRequired }
          : { given: 0, required: needsApproval && status === 'rejected' ? approvalsRequired : 0 };

    const tApproved = allowed ? created + 2 * 60_000 + rng.below(HOUR) : null;
    const executed = ['settling', 'delivering', 'partly_paid', 'paid', 'needs_attention'].includes(
      status,
    );
    const tQuoted = tApproved !== null && method !== 'stellar_wallet' ? tApproved + 30_000 : null;
    const tSettled =
      executed && tApproved !== null ? tApproved + 60_000 + rng.below(10 * 60_000) : null;
    const tDelivered =
      status === 'paid' && tSettled !== null ? tSettled + rng.below(6 * HOUR) : null;

    const legs: PayoutLeg[] = [];
    if (settlement !== null) {
      const parts = split ? allocate(settlement, [7n, 3n]) : [settlement];
      const legStatusFor = (i: number): LegStatus => {
        switch (status) {
          case 'submitting':
            return 'planned';
          case 'pending_approval':
          case 'approved':
            return 'submitted';
          case 'settling':
            return 'settled';
          case 'delivering':
            return i === 0 ? 'delivering' : 'delivered';
          case 'partly_paid':
            return i === 0 ? 'delivered' : 'failed';
          case 'paid':
            return 'delivered';
          case 'needs_attention':
            return i === 0 ? 'failed' : 'delivered';
          default:
            return 'cancelled';
        }
      };
      parts.forEach((part, i) => {
        const legMethod = i === 0 ? method : secondMethod;
        let legStatus = legStatusFor(i);
        // A wallet leg is done once it settles, so it never sits in delivering.
        if (legMethod === 'stellar_wallet' && legStatus === 'delivering') legStatus = 'delivered';
        legs.push(
          this.localLeg(tenant, recipient, legMethod, part, legStatus, i, {
            settled: tSettled,
            delivered: tSettled === null ? null : (tDelivered ?? tSettled + HOUR),
          }),
        );
      });
      if (status === 'partly_paid') {
        const failed = legs[1];
        const part = parts[1];
        if (failed !== undefined && part !== undefined) {
          const fallback = this.localLeg(
            tenant,
            recipient,
            'stellar_wallet',
            part,
            'submitted',
            1,
            { settled: null, delivered: null },
          );
          legs.push({ ...fallback, replacesLegId: failed.id });
        }
      }
    }
    const live = legs.filter((leg) => !legs.some((other) => other.replacesLegId === leg.id));
    const network = settlement === null ? null : tenant.network;
    const takeBps = this.edge && index % 50 === 0 ? 0 : rng.pick([0, 30, 50]);
    const take = settlement === null ? 0n : takeAt(settlement.amount, takeBps);
    const firstLocal = live.find((leg) => leg.received !== null);

    const detail: PayoutDetail = {
      principalId: tenant.principalId,
      projectId: tenant.projectId,
      id: rng.uuid(),
      recipient: {
        id: recipient.id,
        displayName: recipient.displayName,
        country: recipient.country,
      },
      mandate: { id: mandate.id, name: mandate.name },
      requested: wire(requested),
      received: firstLocal?.received ?? null,
      settlement: settlement === null ? null : toWireToken(settlement, tenant.network),
      status,
      queuedReason:
        status === 'queued'
          ? rng.pick(['awaiting_funding', 'network_unavailable', null] as const)
          : null,
      blockedBy:
        status === 'blocked'
          ? rng.pick([
              'DAILY_CAP_EXCEEDED',
              'PER_PAYMENT_CAP_EXCEEDED',
              'RECIPIENT_NOT_ALLOWED',
              'BUDGET_EXCEEDED',
            ])
          : null,
      corridor: recipient.country,
      method: live[0]?.method ?? method,
      legCount: live.length,
      network,
      createdAt: iso(created),
      settledAt: tSettled === null ? null : iso(tSettled),
      taskId: rng.chance(60) ? `fixture-task-${rng.hex(8)}` : null,
      legs,
      charges:
        settlement === null
          ? null
          : {
              settlement: toWireToken(settlement, tenant.network),
              take: token(take, tenant.network),
              takeBps,
              charged: token(settlement.amount + take, tenant.network),
            },
      cashOutBearer: tenant.cashOutBearer,
      timeline: [
        { step: 'requested', at: iso(created) },
        { step: 'approved', at: tApproved === null ? null : iso(tApproved) },
        { step: 'quoted', at: tQuoted === null ? null : iso(tQuoted) },
        { step: 'settled', at: tSettled === null ? null : iso(tSettled) },
        { step: 'delivered', at: tDelivered === null ? null : iso(tDelivered) },
      ],
      allowedBy,
      approvals,
      receipt: null,
      updatedAt: iso(tDelivered ?? tSettled ?? tApproved ?? created),
    };

    if (status === 'paid' && settlement !== null && allowedBy !== null && tDelivered !== null) {
      this.addReceipt(tenant, detail, mandate, allowedBy, tDelivered);
    } else {
      this.payouts.push(detail);
    }
    if (status === 'pending_approval' && settlement !== null && detail.charges !== null) {
      this.approvals.push({
        principalId: tenant.principalId,
        projectId: tenant.projectId,
        payoutId: detail.id,
        attemptId: rng.uuid(),
        mandate: detail.mandate,
        mandateInstanceId: instance.id,
        recipient: detail.recipient,
        requested: detail.requested,
        settlement: detail.charges.settlement,
        take: detail.charges.take,
        charged: detail.charges.charged,
        network: tenant.network,
        approvalReason: 'above_threshold',
        approvalThreshold: mandate.limits.approvalThreshold,
        remainingBudget: instance.budget.remaining,
        approvals: detail.approvals,
        requestedAt: detail.createdAt,
        expiresAt: iso(created + DAY),
      });
    }
  }

  private addReceipt(
    tenant: FixtureTenant,
    detail: PayoutDetail,
    mandate: MandateDetail,
    allowedBy: AllowedBy,
    delivered: number,
  ): void {
    const rng = this.rng;
    const charges = detail.charges;
    if (charges === null || detail.settlement === null) return;
    const number = receiptNumber(rng);
    const id = rng.uuid();
    const first = detail.legs[0];
    const ref = `ujira:tx:v1:${tenant.network}:${first?.txHash ?? fakeHash(rng)}:${String(rng.below(4))}`;
    this.payouts.push({ ...detail, receipt: { id, receiptNumber: number, receiptRef: ref } });
    const issuedAt = iso(delivered + 60_000);
    const verifyUrl = `https://receipts.example/${number}`;
    const documentSha256 = rng.hex(64);
    const payerDisplayName = tenant.receiptSettings.showPayerName ? tenant.principalName : null;
    // A take refund happens only after a refunded leg; kept to the edge set.
    const refunded = this.edge && rng.chance(3) ? BigInt(charges.take.amount) / 2n : 0n;
    const revision = refunded > 0n ? 2 : 1;
    this.receipts.push({
      view: 'principal',
      principalId: tenant.principalId,
      projectId: tenant.projectId,
      receiptNumber: number,
      revision,
      issuedAt,
      verifyUrl,
      payerDisplayName,
      status: 'paid',
      deliveredAt: iso(delivered),
      documentSha256,
      id,
      supersedesReceiptId: revision === 1 ? null : rng.uuid(),
      receiptRef: ref,
      payoutId: detail.id,
      taskId: detail.taskId,
      mandateId: mandate.id,
      recipient: detail.recipient,
      recipientRef: rng.hex(64),
      attempt: 0,
      requested: detail.requested,
      settlement: detail.settlement,
      take: charges.take,
      takeBps: charges.takeBps,
      takeRefunded: token(refunded, tenant.network),
      charged: charges.charged,
      legs: detail.legs.map((leg) => ({
        index: leg.index,
        method: leg.method,
        rail: leg.rail,
        network: tenant.network,
        amount: leg.amount,
        received: leg.received,
        maskedDestination: leg.maskedDestination,
        anchorName: leg.anchorName,
        cashOut: leg.cashOut,
        txHash: leg.txHash ?? fakeHash(rng),
        anchorTransactionId: leg.anchorTransactionId,
        deliveredAt: iso(delivered),
      })),
      allowedBy,
      approvals: detail.approvals,
      timeline: detail.timeline,
    });
    this.recipientReceipts.push({
      view: 'recipient',
      receiptNumber: number,
      revision,
      issuedAt,
      verifyUrl,
      payerDisplayName,
      status: 'paid',
      deliveredAt: iso(delivered),
      documentSha256,
      legs: detail.legs.map((leg) => {
        const hash = leg.txHash ?? fakeHash(rng);
        if (leg.method === 'stellar_wallet' || leg.received === null || leg.cashOut === null) {
          return {
            method: 'stellar_wallet' as const,
            received: leg.amount,
            maskedDestination: leg.maskedDestination,
            txHash: hash,
            explorerUrl: `https://explorer.example/tx/${hash}`,
          };
        }
        const currency = leg.received.currency;
        const usd = parseRate(leg.cashOut.rate.rate, { base: 'USDC', quote: currency });
        const fee = wire(convertMoney(core(leg.cashOut.anchorFee), usd, { currency }, 'half-even'));
        const bore = leg.cashOut.bearer === 'recipient';
        const rate = { rate: leg.cashOut.rate.rate, base: 'USD' as const, quote: currency };
        return {
          method: leg.method,
          received: leg.received,
          maskedDestination: leg.maskedDestination,
          anchorName: leg.anchorName ?? 'Fixture Anchor',
          costs: bore ? { anchorFee: fee, rate } : null,
        };
      }),
    });
  }

  buildFunding(tenant: FixtureTenant): void {
    const rng = this.rng;
    const mandates = this.mandates.filter((m) => m.projectId === tenant.projectId);
    const accounts = mandates.flatMap((m) =>
      m.instances.flatMap((i) => {
        if (i.fundingAddress === null) return [];
        const lowCase = this.lowBalanceCase.get(i.id) ?? 'none';
        const unit = 10_000_000n;
        const dailySpend = rng.bigBetween(10n, 2_000n) * unit;
        let committed = rng.bigBetween(0n, 20_000n) * unit;
        const fixed = m.lowBalance.fixed === null ? null : BigInt(m.lowBalance.fixed.amount);
        const runway = BigInt(m.lowBalance.runwayDays ?? 0) * dailySpend;
        let available: bigint;
        switch (lowCase) {
          case 'both':
            // At zero in the edge set, which also covers an empty account.
            available = this.edge ? 0n : (fixed ?? 0n) < runway ? (fixed ?? 0n) / 2n : runway / 2n;
            if (this.edge) committed = 0n;
            break;
          case 'runway':
            available = runway / 2n;
            break;
          case 'fixed':
            available = (fixed ?? 0n) / 2n;
            break;
          case 'fallback':
            // Under seven days of history the runway rule compares the free
            // balance with what is already committed.
            committed = committed + 1_000n * unit;
            available = committed / 2n;
            break;
          default:
            available = runway * 2n + (fixed ?? 0n) * 2n + unit;
        }
        const runwayLimit = lowCase === 'fallback' ? committed : runway;
        const firedBy: ('runway' | 'fixed')[] = [];
        if (m.lowBalance.runwayDays !== null && available < runwayLimit) firedBy.push('runway');
        if (fixed !== null && available < fixed) firedBy.push('fixed');
        const triggered = firedBy.length > 0;
        return [
          {
            mandateId: m.id,
            mandateName: m.name,
            mandateInstanceId: i.id,
            status: i.status,
            network: i.network,
            asset: i.asset,
            fundingAddress: i.fundingAddress,
            balance: {
              total: token(available + committed, i.network),
              available: token(available, i.network),
              committed: token(committed, i.network),
            },
            lowBalance: {
              runwayDays: m.lowBalance.runwayDays,
              fixed: m.lowBalance.fixed,
              triggered,
              firedBy,
              since: triggered ? iso(BASE_TIME - rng.below(72) * HOUR) : null,
            },
          },
        ];
      }),
    );
    const deposits: Deposit[] = [];
    accounts.forEach((account, a) => {
      const count = this.edge ? DEPOSIT_STATUSES.length + 1 : rng.between(1, 4);
      for (let d = 0; d < count; d += 1) {
        const status = this.edge
          ? (DEPOSIT_STATUSES[d % DEPOSIT_STATUSES.length] ?? 'seen')
          : rng.pick(DEPOSIT_STATUSES);
        const seen = BASE_TIME - (a * 10 + d) * HOUR - rng.below(HOUR);
        // Dust and the i128 bound are both legal deposits.
        const amount =
          this.edge && d === 0
            ? 1n
            : this.edge && d === 1 && a === 0
              ? I128_MAX
              : rng.bigBetween(1n, 20_000n) * 10_000_000n;
        deposits.push({
          principalId: tenant.principalId,
          projectId: tenant.projectId,
          id: rng.uuid(),
          mandateInstanceId: account.mandateInstanceId,
          network: account.network,
          amount: token(amount, account.network),
          fromAddress: this.address('G', 'DEPOSITOR'),
          txHash: fakeHash(rng),
          status,
          seenAt: iso(seen),
          confirmedAt: status === 'seen' ? null : iso(seen + 5_000),
          reversedAt: status === 'reversed' ? iso(seen + 60_000) : null,
        });
      }
    });
    deposits.sort((x, y) =>
      x.seenAt === y.seenAt ? (x.id < y.id ? 1 : -1) : x.seenAt < y.seenAt ? 1 : -1,
    );
    this.deposits.push(...deposits);
    this.funding.push({
      principalId: tenant.principalId,
      projectId: tenant.projectId,
      accounts,
      // Every deposit fits on the first page here; the mocks page them.
      deposits: { items: deposits, nextCursor: null },
    });
  }
}

/** Builds a complete, internally consistent data set from a seed. */
export function generateFixtures(options: FixtureOptions): FixtureSet {
  const edge = options.edge ?? false;
  const total = options.payouts ?? 120;
  const b = new Builder(options.seed, edge);
  b.buildTenants();
  b.tenants.forEach((tenant, i) => {
    b.buildRecipients(tenant, i);
  });

  // Mandates: in the edge set, every status and every recipient mode in the
  // first project, plus a zero and a maximum budget.
  b.tenants.forEach((tenant, t) => {
    if (edge && t === 0) {
      let n = 0;
      for (const mode of RECIPIENT_MODES) b.buildMandate(tenant, 'active', mode, n++, 'none');
      for (const status of MANDATE_STATUSES)
        b.buildMandate(tenant, status, 'allowlist', n++, 'none');
      b.buildMandate(tenant, 'active', 'both', n++, 'zero');
      b.buildMandate(tenant, 'active', 'allowlist', n++, 'max');
      // A draft whose deployment failed, so both draft instance states exist.
      while (!b.mandates.some((m) => m.instances.some((i) => i.status === 'deploy_failed'))) {
        b.buildMandate(tenant, 'draft', 'allowlist', n++, 'none');
      }
      while (!b.mandates.some((m) => m.instances.some((i) => i.status === 'deploying'))) {
        b.buildMandate(tenant, 'draft', 'allowlist', n++, 'none');
      }
    } else {
      b.buildMandate(
        tenant,
        'active',
        RECIPIENT_MODES[t % RECIPIENT_MODES.length] ?? 'allowlist',
        0,
        'none',
      );
      b.buildMandate(tenant, t === 2 ? 'paused' : 'active', 'allowlist', 1, 'none');
    }
  });

  // Payouts: most in the first project, the rest spread over the others so
  // tenant scoping is visible. The edge set starts with every status, every
  // method, every leg status, every allowedBy and each dollar currency.
  const forcedList: { status: PayoutStatus; forced: Forced }[] = [];
  if (edge) {
    for (const status of PAYOUT_STATUSES) forcedList.push({ status, forced: {} });
    for (const method of PAYOUT_METHODS) forcedList.push({ status: 'paid', forced: { method } });
    for (const currency of ['USD', 'COP', 'MXN'] as const)
      forcedList.push({ status: 'paid', forced: { currency } });
    for (const allowedBy of ALLOWED_BY) forcedList.push({ status: 'paid', forced: { allowedBy } });
    forcedList.push(
      { status: 'pending_approval', forced: {} },
      { status: 'pending_approval', forced: {} },
    );
  }
  for (let i = 0; i < total; i += 1) {
    const tenantIndex = i % 10 < 7 ? 0 : i % 10 < 9 ? 1 : 2;
    const tenant = b.tenants[tenantIndex];
    if (tenant === undefined) continue;
    const item = forcedList[i];
    if (item !== undefined) {
      b.buildPayout(b.tenants[0] ?? tenant, item.status, i, item.forced);
    } else {
      const status = b.payoutStatus();
      b.buildPayout(tenant, status, i, {});
    }
  }

  b.tenants.forEach((tenant) => {
    b.buildFunding(tenant);
  });

  const newestFirst = <T extends { createdAt: string; id: string }>(rows: T[]): T[] =>
    rows.sort((x, y) =>
      x.createdAt === y.createdAt ? (x.id < y.id ? 1 : -1) : x.createdAt < y.createdAt ? 1 : -1,
    );

  const receiptPairs = b.receipts.map((receipt, i) => [receipt, b.recipientReceipts[i]] as const);
  receiptPairs.sort(([x], [y]) =>
    x.issuedAt === y.issuedAt ? (x.id < y.id ? 1 : -1) : x.issuedAt < y.issuedAt ? 1 : -1,
  );

  return {
    seed: options.seed,
    tenants: b.tenants,
    mandates: newestFirst(b.mandates),
    payouts: newestFirst(b.payouts),
    receipts: receiptPairs.map(([r]) => r),
    recipientReceipts: receiptPairs
      .map(([, r]) => r)
      .filter((r): r is RecipientReceipt => r !== undefined),
    funding: b.funding,
    deposits: b.deposits,
    lowBalanceCases: b.lowBalanceCase,
    approvals: [...b.approvals].sort((x, y) =>
      x.requestedAt === y.requestedAt
        ? x.payoutId < y.payoutId
          ? -1
          : 1
        : x.requestedAt < y.requestedAt
          ? -1
          : 1,
    ),
  };
}

export function toMandateListItem(detail: MandateDetail): MandateListItem {
  return {
    principalId: detail.principalId,
    projectId: detail.projectId,
    id: detail.id,
    name: detail.name,
    status: detail.status,
    recipientMode: detail.recipientMode,
    limits: detail.limits,
    expiresAt: detail.expiresAt,
    createdAt: detail.createdAt,
    instances: detail.instances.map((i) => ({
      id: i.id,
      network: i.network,
      asset: i.asset,
      status: i.status,
      budget: i.budget,
    })),
  };
}

export function toPayoutListItem(detail: PayoutDetail): PayoutListItem {
  return {
    principalId: detail.principalId,
    projectId: detail.projectId,
    id: detail.id,
    recipient: detail.recipient,
    mandate: detail.mandate,
    requested: detail.requested,
    received: detail.received,
    settlement: detail.settlement,
    status: detail.status,
    queuedReason: detail.queuedReason,
    blockedBy: detail.blockedBy,
    corridor: detail.corridor,
    method: detail.method,
    legCount: detail.legCount,
    network: detail.network,
    createdAt: detail.createdAt,
    settledAt: detail.settledAt,
  };
}

export function toReceiptListItem(receipt: PrincipalReceipt): ReceiptListItem {
  return {
    principalId: receipt.principalId,
    projectId: receipt.projectId,
    id: receipt.id,
    payoutId: receipt.payoutId,
    receiptNumber: receipt.receiptNumber,
    revision: receipt.revision,
    issuedAt: receipt.issuedAt,
    recipient: receipt.recipient,
    requested: receipt.requested,
    charged: receipt.charged,
  };
}
