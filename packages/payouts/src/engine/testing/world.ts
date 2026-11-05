// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The real database and the fake chain, joined up: the tenant the fake chain acts for
// exists as real rows, with its recipient and mandate, and a job runs through the same
// handler a pool would call.

import { createHash } from 'node:crypto';

import type {
  Bytes32,
  ChainAdapter,
  ChainAdapterRegistry,
  CountryCode,
  NetworkId,
  UnixSeconds,
} from '@ujira/chain-adapter';
import { encodeAccountAddress } from '@ujira/chain-adapter/codecs';
import {
  act,
  deployMandate,
  FAKE_SCOPES,
  fakeAdapterHarness,
  type AdapterHarness,
  type FakeWorld,
  type SuiteMandate,
} from '@ujira/chain-adapter/testing';
import { tokenAmount, type Money, type TokenAmount } from '@ujira/core';
import {
  mandateInstances,
  mandates,
  payoutBatches,
  payoutMethods,
  payouts,
  recipients,
  type Database,
  type NewPayout,
  type Payout,
  type PayoutMinimumMethod,
  type ProjectContext,
  type TenantTx,
} from '@ujira/db';
import { adminQuery } from '@ujira/db/testing';
import { createMemoryComplianceStore } from '@ujira/mandates';
import { adapterRouteQuotes, parseRoutingConfig, type RoutingConfig } from '@ujira/router';

import { tenantTask, type WorkerAlert } from '../../worker/handlers.js';
import { PAYOUT_ADVANCE, type TaskIds } from '../../worker/tasks.js';
import { helpersFor, type WorkerHarness } from '../../worker/testing/support.js';
import { advanceWork } from '../advance.js';
import type { EngineDeps } from '../plan.js';
import { databaseDestinations, databaseMandates } from '../routing.js';

export const NETWORK: NetworkId = 'stellar:testnet';
export const TENANT: ProjectContext = {
  principalId: FAKE_SCOPES.scope.principalId,
  projectId: FAKE_SCOPES.scope.projectId,
};

export const usdc = (raw: bigint): TokenAmount => tokenAmount(raw, 'USDC', 'stellar');

// 1.00 USDC at seven decimals, which is the wallet method's floor.
export const ONE_USDC = 10_000_000n;

const account = (fill: number): string => encodeAccountAddress(new Uint8Array(32).fill(fill));
const key = (keyId: string, fill: number): Record<string, unknown> => ({
  provider: 'aws_kms',
  keyId,
  address: account(fill),
});

const FAKE_ANCHOR = {
  anchorId: 'anchor-a.example',
  currency: 'NGN',
  country: 'NG' as CountryCode,
  // Two kobo for every 1000 raw units of USDC, so 1.00 USDC buys 200.00 naira.
  rate: { numerator: 2n, denominator: 1_000n },
  fee: 500_000n,
  steps: [],
} as const;

export function routingConfig(): RoutingConfig {
  return parseRoutingConfig({
    schemaVersion: 1,
    networks: {
      [NETWORK]: {
        enabled: true,
        rpc: [{ url: 'secretRef:testnet_rpc_primary', weight: 1 }],
        maxEndpointLagSeconds: 15,
        trustedFactories: { '1': ['CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'] },
        assets: {
          USDC: {
            sac: 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ',
            issuer: 'GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC',
          },
        },
        deposits: { startLedger: 0, availableAt: 'included', pageEvents: 500 },
        executor: { txValiditySeconds: 60, keys: [key('alias/ujira-executor-0', 1)] },
        feeSponsor: {
          perPrincipalFundingAccounts: 1,
          reserveSponsorshipDailyStroops: '500000000',
          maxFeePerTxStroops: '1000000',
          perPrincipalPerMinute: 10,
          perPrincipalDailyCount: 200,
          perPrincipalDailyFeeStroops: '50000000',
          globalDailyFeeStroops: '5000000000',
          lowBalanceStroops: '1000000000',
          minBalanceStroops: '100000000',
          key: key('alias/ujira-fee-sponsor', 2),
        },
        sep10: [{ anchorId: 'anchor-a.example', key: key('alias/ujira-sep10-a', 3) }],
        signingWindowSeconds: 300,
        explorer: { tx: 'https://stellar.expert/explorer/testnet/tx/{hash}' },
        health: {
          maxHeadLagSeconds: 30,
          degradedErrorBps: 500,
          downErrorBps: 5000,
          hysteresisChecks: 3,
        },
      },
    },
    rails: [
      {
        id: 'anchor_a',
        network: NETWORK,
        rail: 'stellar.sep31',
        provider: 'anchor-a.example',
        enabled: true,
      },
      { id: 'wallet', network: NETWORK, rail: 'stellar.wallet', enabled: true },
    ],
    corridors: [
      {
        country: 'NG',
        method: 'stellar_wallet',
        currency: 'USDC',
        enabled: true,
        strategy: 'priority',
        candidates: [{ rail: 'wallet', priority: 1 }],
      },
      {
        country: 'NG',
        method: 'bank',
        currency: 'NGN',
        enabled: true,
        strategy: 'priority',
        candidates: [{ rail: 'anchor_a', priority: 1 }],
      },
      {
        country: 'NG',
        method: 'mobile_money',
        currency: 'NGN',
        enabled: true,
        strategy: 'priority',
        candidates: [{ rail: 'anchor_a', priority: 1 }],
      },
    ],
  });
}

// The tenant the fake chain knows, as real rows. Once per database.
export async function seedTenant(harness: WorkerHarness): Promise<void> {
  await adminQuery(
    harness.database.url,
    `insert into ujira.principals (id, name) values ($1, 'Fake') on conflict do nothing`,
    [TENANT.principalId],
  );
  await adminQuery(
    harness.database.url,
    `insert into ujira.projects (principal_id, id, name) values ($1, $2, 'Fake')
     on conflict do nothing`,
    [TENANT.principalId, TENANT.projectId],
  );
}

let worlds = 0;

export interface EngineWorld {
  readonly h: AdapterHarness & { readonly world: FakeWorld };
  readonly m: SuiteMandate;
  readonly deps: EngineDeps;
  readonly db: Database;
  readonly mandateId: string;
  readonly instanceId: string;
  readonly recipientId: string;
  readonly walletMethodId: string;
  // The fake chain allowlists a second recipient, with no wallet on record here.
  readonly secondRecipientId: string;
  readonly alerts: WorkerAlert[];
  // Each call the adapter's quote received, on the deps' own adapter.
  readonly quotes: unknown[];
  readonly pays: unknown[];
  readonly batches: unknown[];
  batch(
    key: string,
    amounts: readonly TokenAmount[],
    options?: { readonly secondRecipientAt?: number },
  ): Promise<{ readonly batchId: string; readonly payouts: readonly Payout[] }>;
  addMethod(method: PayoutMinimumMethod, recipient?: 0 | 1): Promise<string>;
  payout(key: string, requested: Money | TokenAmount, extra?: Partial<NewPayout>): Promise<Payout>;
  // One job, as a pool would run it.
  run(
    payout: Payout,
    options?: { readonly deps?: EngineDeps; readonly jobId?: string },
  ): Promise<void>;
  // Runs jobs, moving the chain on, until the payout rests or the runs run out.
  drive(
    payout: Payout,
    options?: { readonly deps?: EngineDeps; readonly runs?: number },
  ): Promise<Payout>;
  read(payoutId: string): Promise<Payout>;
  executed(onChainId: string): number;
  balanceOfRecipient(): Promise<bigint>;
}

export interface WorldOptions {
  readonly fund?: bigint;
  readonly anchor?: boolean;
  readonly attester?: Uint8Array;
  readonly attestationsFor?: EngineDeps['attestationsFor'];
  readonly feeBps?: bigint;
  readonly overrides?: Partial<EngineDeps>;
  readonly anchorSteps?: readonly unknown[];
  readonly approvers?: number;
  readonly approvalThreshold?: bigint;
}

// As deployMandate does, but the mandate checks attestations instead of a list.
async function deployAttested(
  h: AdapterHarness,
  attester: Uint8Array,
  salt: string,
  fund: bigint,
): Promise<SuiteMandate> {
  const network = h.adapter.network;
  const principal = h.wallet('principal');
  const salted = `0x${createHash('sha256').update(salt).digest('hex')}` as Bytes32;
  const opts = { signal: new AbortController().signal, correlationId: 'world' };
  const expiresAt = ((await h.adapter.health(opts)).checkedAt + 2_592_000n) as UnixSeconds;
  await act(
    h,
    null,
    {
      op: 'create',
      factory: h.factory,
      salt: salted,
      config: {
        principal,
        asset: 'USDC',
        recipientMode: 'attested',
        agents: [h.managedAgent.address],
        approvers: [],
        approvalsRequired: 0,
        guardians: [],
        executors: [...h.executors],
        recovery: [],
        recoveryThreshold: 0,
        limits: {
          totalBudget: usdc(10_000_000_000n),
          perPaymentCap: usdc(100_000_000n),
          perRecipientDailyCap: usdc(500_000_000n),
          approvalThreshold: usdc(100_000_001n),
          payoutTtlSeconds: 86_400,
          expiresAt,
        },
        attester,
        countryPolicyHash: `0x${'22'.repeat(32)}` as Bytes32,
        maxFeeBps: 100,
      },
    },
    principal,
  );
  const address = h.mandateAddress(principal, salted);
  const recipients_ = [0, 1].map((index) => {
    const wallet = h.wallet(`recipient-${String(index)}`);
    return {
      recipientRef: `0x${createHash('sha256')
        .update(`recipient-${String(index)}`)
        .digest('hex')}` as Bytes32,
      methodId: h.recipientMethod({ address: wallet, tag: null }),
      address: wallet,
    };
  });
  await h.fund(address, fund);
  return {
    ref: { network, address, specVersion: 1 },
    principal,
    approvers: [],
    recovery: [],
    recipients: recipients_,
    expiresAt,
  };
}

export class Killed extends Error {
  override readonly name = 'Killed';
}

// Dies right after the nth write commits or chain call returns, which is what a killed
// process leaves: the write stands, and the code after it never runs. This is in
// process, so it simulates the kill rather than sending a signal.
export function killing(
  deps: EngineDeps,
  target: number,
): { readonly deps: EngineDeps; readonly boundaries: () => number } {
  let seen = 0;
  const boundary = (): void => {
    seen += 1;
    if (seen === target) throw new Killed(`killed at boundary ${String(target)}`);
  };
  const db = new Proxy(deps.db, {
    get(real, property) {
      if (property === 'tenant') {
        return (context: ProjectContext) => ({
          transaction: async (work: (tx: TenantTx) => Promise<unknown>) => {
            const result = await real.tenant(context).transaction(work);
            boundary();
            return result;
          },
        });
      }
      const value: unknown = Reflect.get(real, property);
      return typeof value === 'function' ? (value as () => unknown).bind(real) : value;
    },
  });
  const adapter = (real: ChainAdapter): ChainAdapter =>
    new Proxy(real, {
      get(on, property) {
        const value: unknown = Reflect.get(on, property);
        if (typeof value !== 'function') return value;
        if (property !== 'pay' && property !== 'payBatch') {
          return (value as () => unknown).bind(on);
        }
        return async (...args: readonly unknown[]) => {
          const step: unknown = await (value as (...a: unknown[]) => Promise<unknown>).apply(on, [
            ...args,
          ]);
          boundary();
          return step;
        };
      },
    });
  const adapters: ChainAdapterRegistry = {
    get: (network) => adapter(deps.adapters.get(network)),
    list: () => deps.adapters.list().map(adapter),
  };
  return { deps: { ...deps, db, adapters }, boundaries: () => seen };
}

const RAIL_OF_METHOD: Readonly<Record<PayoutMinimumMethod, 'wallet' | 'anchor'>> = {
  stellar_wallet: 'wallet',
  bank: 'anchor',
  mobile_money: 'anchor',
  cash_pickup: 'anchor',
};

const nothingAttested: EngineDeps['attestationsFor'] = () =>
  Promise.resolve({ attestations: [], earliestValidUntil: null });

function spying(
  adapter: ChainAdapter,
  calls: { readonly quotes: unknown[]; readonly pays: unknown[]; readonly batches: unknown[] },
): ChainAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      const seen = { quote: calls.quotes, pay: calls.pays, payBatch: calls.batches }[
        property as string
      ];
      if (seen !== undefined) {
        return (...args: readonly unknown[]): unknown => {
          seen.push(args[0]);
          return (value as (...a: readonly unknown[]) => unknown).apply(target, [...args]);
        };
      }
      return (value as (...a: readonly unknown[]) => unknown).bind(target);
    },
  });
}

export async function engineWorld(
  harness: WorkerHarness,
  options: WorldOptions = {},
): Promise<EngineWorld> {
  worlds += 1;
  const salt = `world-${String(worlds)}`;
  const h = fakeAdapterHarness({ network: NETWORK });
  const net = h.world.net;
  if (options.anchor === true) {
    h.faults?.anchorScript({ ...FAKE_ANCHOR, steps: (options.anchorSteps ?? []) as never[] });
  }
  const m =
    options.attester === undefined
      ? await deployMandate(h, {
          fund: options.fund ?? ONE_USDC * 1_000n,
          salt,
          ...(options.approvers === undefined ? {} : { approvers: options.approvers }),
          ...(options.approvalThreshold === undefined
            ? {}
            : { approvalThreshold: options.approvalThreshold }),
        })
      : await deployAttested(h, options.attester, salt, options.fund ?? ONE_USDC * 1_000n);
  const rows = await harness.db.tenant(TENANT).transaction(async (tx) => {
    const mandate = await mandates.create(tx, { name: salt });
    const instance = await mandateInstances.create(tx, {
      mandateId: mandate.id,
      chain: 'stellar',
      contractAddress: m.ref.address.value,
      specVersion: '1',
      asset: 'USDC',
      scale: 7,
    });
    const first = m.recipients[0];
    if (first === undefined) throw new Error('the mandate has no recipient');
    const ref = Buffer.from(first.recipientRef.slice(2), 'hex');
    // The fake chain's recipient is the same in every world, and so one row here.
    const existing = await adminQuery<{ id: string }>(
      harness.database.url,
      'select id from ujira.recipients where recipient_ref = $1 and project_id = $2',
      [ref, TENANT.projectId],
    );
    const recipientId =
      existing[0]?.id ?? (await recipients.create(tx, { recipientRef: ref, country: 'NG' })).id;
    const methods = await payoutMethods.forRecipient(tx, recipientId, 100);
    const wallet =
      methods.find((method) => method.method === 'stellar_wallet') ??
      (await payoutMethods.create(tx, {
        recipientId,
        method: 'stellar_wallet',
        rail: 'wallet',
        chain: 'stellar',
        destinationAddress: first.address.value,
        destinationTag: null,
        details: null,
      }));
    const second = m.recipients[1];
    if (second === undefined) throw new Error('the mandate has no second recipient');
    const secondRef = Buffer.from(second.recipientRef.slice(2), 'hex');
    const knownSecond = await adminQuery<{ id: string }>(
      harness.database.url,
      'select id from ujira.recipients where recipient_ref = $1 and project_id = $2',
      [secondRef, TENANT.projectId],
    );
    const secondRecipientId =
      knownSecond[0]?.id ??
      (await recipients.create(tx, { recipientRef: secondRef, country: 'NG' })).id;
    return {
      mandateId: mandate.id,
      instanceId: instance.id,
      recipientId,
      walletMethodId: wallet.id,
      secondRecipientId,
    };
  });
  const first = m.recipients[0];
  if (first === undefined) throw new Error('the mandate has no recipient');
  net.registerRecipientMethod(rows.walletMethodId, { address: first.address, tag: null });

  const quotes: unknown[] = [];
  const pays: unknown[] = [];
  const batches: unknown[] = [];
  const wrapped = spying(h.adapter, { quotes, pays, batches });
  const enabled = new Map([[NETWORK, wrapped]]);
  const adapters: ChainAdapterRegistry = {
    get: (network) => {
      const adapter = enabled.get(network);
      if (adapter === undefined) throw new RangeError('network is not enabled');
      return adapter;
    },
    list: () => [wrapped],
  };
  const alerts: WorkerAlert[] = [];
  const bps = options.feeBps ?? 100n;
  const deps: EngineDeps = {
    db: harness.db,
    adapters,
    routing: {
      config: routingConfig,
      adapters,
      mandates: databaseMandates(harness.db, adapters),
      destinations: databaseDestinations(harness.db, adapters),
      quotes: adapterRouteQuotes(adapters),
      compliance: createMemoryComplianceStore(),
      feeFor: (_network, total) => usdc((total.amount * bps) / 10_000n),
    },
    signerFor: () => h.managedAgent.ref,
    attestationsFor: options.attestationsFor ?? nothingAttested,
    alert: (alert) => alerts.push(alert),
    now: () => Number(net.now()) * 1_000,
    ...options.overrides,
  };
  const world: EngineWorld = {
    h,
    m,
    deps,
    db: harness.db,
    ...rows,
    alerts,
    quotes,
    pays,
    batches,
    batch: async (key, amounts, batch = {}) =>
      harness.db.tenant(TENANT).transaction(async (tx) => {
        const created = await payoutBatches.create(tx, {
          idempotencyKey: `batch-${key}-${salt}`,
          items: amounts.map((requested, index) => ({
            idempotencyKey: `${key}-${salt}-${String(index)}`,
            recipientId:
              index === batch.secondRecipientAt ? rows.secondRecipientId : rows.recipientId,
            mandateId: rows.mandateId,
            method: 'stellar_wallet',
            requested,
          })),
        });
        return {
          batchId: created.batch.id,
          payouts: created.items.flatMap((item) =>
            item.outcome === 'refused' ? [] : [item.payout],
          ),
        };
      }),
    addMethod: async (method, recipient = 0) => {
      const holder = recipient === 0 ? rows.recipientId : rows.secondRecipientId;
      const destination = m.recipients[recipient];
      if (destination === undefined) throw new Error('no such recipient');
      const row = await harness.db.tenant(TENANT).transaction(async (tx) => {
        const existing = await payoutMethods.forRecipient(tx, holder, 100);
        return (
          existing.find((candidate) => candidate.method === method) ??
          payoutMethods.create(tx, {
            recipientId: holder,
            method,
            rail: RAIL_OF_METHOD[method],
            chain: 'stellar',
            destinationAddress: destination.address.value,
            destinationTag: null,
            details: null,
          })
        );
      });
      net.registerRecipientMethod(row.id, { address: destination.address, tag: null });
      return row.id;
    },
    payout: async (idempotencyKey, requested, extra = {}) =>
      harness.db.tenant(TENANT).transaction(async (tx) => {
        const created = await payouts.create(tx, {
          idempotencyKey,
          recipientId: rows.recipientId,
          mandateId: rows.mandateId,
          method: 'stellar_wallet',
          requested,
          ...extra,
        });
        return created.payout;
      }),
    run: async (payout, run = {}) => {
      const used = run.deps ?? deps;
      const ids: TaskIds = { payoutId: payout.id, mandateId: payout.mandateId };
      const handler = tenantTask(PAYOUT_ADVANCE, advanceWork(used), {
        db: used.db,
        alert: used.alert,
      });
      await handler({ ...TENANT, ...ids }, helpersFor(run.jobId ?? '1'));
    },
    drive: async (payout, run = {}) => {
      for (let i = 0; i < (run.runs ?? 15); i += 1) {
        await world.run(payout, run);
        await h.advance(6n);
        const now = await world.read(payout.id);
        if (RESTING.has(now.status)) return now;
      }
      return world.read(payout.id);
    },
    read: async (payoutId) => {
      const found = await harness.db
        .tenant(TENANT)
        .transaction(async (tx) => payouts.get(tx, payoutId));
      if (found === undefined) throw new Error('no such payout');
      return found;
    },
    executed: (onChainId) =>
      net.txs
        .flatMap((tx) => tx.events)
        .filter(
          (event) => event.name === 'payout_executed' && event.fields['payout_id'] === onChainId,
        ).length,
    balanceOfRecipient: async () => h.balance(first.address),
  };
  return world;
}

const RESTING: ReadonlySet<string> = new Set([
  'paid',
  'rejected',
  'failed',
  'cancelled',
  'blocked',
  'needs_attention',
]);
