// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The chain adapter's storage port, over the database. Every tenant call runs in that
// tenant's own transaction, so row level security holds it to its own rows. A refusal
// reaches the adapter as one of its own typed errors, never a driver's.

import {
  InvalidInputError,
  type AdapterStore,
  type ChainAdapterErrorCode,
  type ExecutorLease,
  type LegDeliveryRecord,
  type LegKey,
  type NetworkId,
  type PayoutId,
  type QuoteId,
  type RailId,
  type SubmissionOp,
  type SubmissionPatch,
  type SubmissionRecord,
  type SubmissionState,
  type TenantScope,
  type UnixSeconds,
  type Uuid,
} from '@ujira/chain-adapter';

import type { Database } from '../database.js';
import {
  chainSubmissions,
  chainSubmissionSweep,
  legDeliveries,
  type ChainSubmission,
  type LegDelivery,
} from './chain-store.js';
import { executors } from './ops.js';

// The refusals a caller is meant to see. Anything else is a fault, and stays one.
const REFUSALS: Readonly<Record<string, string>> = {
  '23505': 'duplicate',
  '23514': 'invalid',
  UJ002: 'immutable',
  UJ004: 'backward',
};

function dateOf(seconds: UnixSeconds): Date {
  return new Date(Number(seconds) * 1000);
}

function secondsOf(date: Date): UnixSeconds {
  return BigInt(Math.floor(date.getTime() / 1000)) as UnixSeconds;
}

function toRecord(row: ChainSubmission): SubmissionRecord {
  return {
    scope: { principalId: row.principalId as Uuid, projectId: row.projectId as Uuid },
    network: row.network as NetworkId,
    txHash: row.txHash,
    op: row.op as SubmissionOp,
    mandate: row.mandate,
    payoutId: row.payoutId as PayoutId | null,
    attempt: row.attempt,
    signerAddress: row.signerAddress,
    sequenceOrNonce: row.sequenceOrNonce,
    maxTime: row.maxTime === null ? null : secondsOf(row.maxTime),
    state: row.state as SubmissionState,
    landedAtHeight: row.landedAtHeight,
    errorCode: row.errorCode as ChainAdapterErrorCode | null,
    specCode: row.specCode,
    replacesTxHash: row.replacesTxHash,
    submittedAtLedger: row.submittedAtLedger,
    reservationId: row.reservationId,
    correlationId: row.correlationId,
    createdAt: secondsOf(row.createdAt),
  };
}

function toDeliveryRecord(scope: TenantScope, row: LegDelivery): LegDeliveryRecord {
  const network = row.network as NetworkId;
  return {
    scope,
    legKey: row.legKey as LegKey,
    network,
    rail: row.rail as RailId,
    provider: row.provider,
    providerRef: row.providerRef,
    destination: {
      address: { network, value: row.destinationAddress },
      tag: row.destinationTag,
    },
    quoteId: row.quoteId as QuoteId | null,
    state: row.state as LegDeliveryRecord['state'],
    rawStatus: row.rawStatus,
    live: row.live,
    expiresAt: row.expiresAt === null ? null : secondsOf(row.expiresAt),
    updatedAt: secondsOf(row.updatedAt),
  };
}

function refused(subject: string, issue: string): InvalidInputError {
  return new InvalidInputError({ issues: [`${subject} (${issue})`] });
}

export class DatabaseAdapterStore implements AdapterStore {
  readonly #db: Database;
  readonly #clock: () => UnixSeconds;

  constructor(options: { readonly db: Database; readonly clock?: () => UnixSeconds }) {
    this.#db = options.db;
    this.#clock = options.clock ?? (() => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds);
  }

  async #refusing<T>(subject: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const issue = REFUSALS[(error as { code?: string }).code ?? ''];
      if (issue !== undefined) throw refused(subject, issue);
      throw error;
    }
  }

  async recordSubmission(s: SubmissionRecord): Promise<void> {
    if (s.state !== 'built') throw refused('submission.state', 'not_built');
    await this.#refusing('submission', async () =>
      this.#db.tenant(s.scope).transaction(async (tx) =>
        chainSubmissions.record(tx, {
          network: s.network,
          txHash: s.txHash,
          op: s.op,
          mandate: s.mandate,
          payoutId: s.payoutId,
          attempt: s.attempt,
          signerAddress: s.signerAddress,
          sequenceOrNonce: s.sequenceOrNonce,
          maxTime: s.maxTime === null ? null : dateOf(s.maxTime),
          replacesTxHash: s.replacesTxHash,
          submittedAtLedger: s.submittedAtLedger,
          reservationId: s.reservationId,
          correlationId: s.correlationId,
          createdAt: dateOf(s.createdAt),
        }),
      ),
    );
  }

  async updateSubmission(
    scope: TenantScope,
    network: NetworkId,
    txHash: string,
    patch: SubmissionPatch,
  ): Promise<void> {
    const updated = await this.#refusing('submission', async () =>
      this.#db
        .tenant(scope)
        .transaction(async (tx) => chainSubmissions.update(tx, network, txHash, patch)),
    );
    if (updated === undefined) throw refused('submission', 'not_found');
  }

  async landedSubmission(key: {
    readonly scope: TenantScope;
    readonly network: NetworkId;
    readonly mandate: string;
    readonly payoutId: PayoutId;
  }): Promise<SubmissionRecord | null> {
    const row = await this.#db
      .tenant(key.scope)
      .transaction(async (tx) => chainSubmissions.landed(tx, key));
    return row === undefined ? null : toRecord(row);
  }

  async findSubmission(
    scope: TenantScope,
    network: NetworkId,
    txHash: string,
  ): Promise<SubmissionRecord | null> {
    const row = await this.#db
      .tenant(scope)
      .transaction(async (tx) => chainSubmissions.find(tx, network, txHash));
    return row === undefined ? null : toRecord(row);
  }

  async liveSubmission(key: {
    readonly scope: TenantScope;
    readonly network: NetworkId;
    readonly mandate: string;
    readonly payoutId: PayoutId;
    readonly op: SubmissionOp;
  }): Promise<SubmissionRecord | null> {
    const row = await this.#db
      .tenant(key.scope)
      .transaction(async (tx) => chainSubmissions.live(tx, key));
    return row === undefined ? null : toRecord(row);
  }

  async unresolvedSubmissions(
    network: NetworkId,
    olderThanSeconds: number,
    limit: number,
  ): Promise<readonly SubmissionRecord[]> {
    const before = dateOf((this.#clock() - BigInt(olderThanSeconds)) as UnixSeconds);
    const rows = await this.#db.unscoped(async (tx) =>
      chainSubmissionSweep.unresolved(tx, { network, before, limit }),
    );
    return rows.map(toRecord);
  }

  async leaseExecutor(network: NetworkId, leaseSeconds: number): Promise<ExecutorLease> {
    const lease = await this.#db.unscoped(async (tx) =>
      executors.leaseFenced(tx, { network, leaseSeconds }),
    );
    if (lease === undefined) throw refused('executor', 'none_free');
    return {
      network,
      address: { network, value: lease.accountRef },
      keyId: lease.keyId,
      sequenceOrNonce: lease.nextSequence,
      leaseId: lease.leaseId,
      expiresAt: secondsOf(lease.leaseExpiresAt),
    };
  }

  async releaseExecutor(
    lease: ExecutorLease,
    next: { readonly sequenceOrNonce: bigint },
  ): Promise<void> {
    const released = await this.#db.unscoped(async (tx) =>
      executors.releaseFenced(tx, {
        network: lease.network,
        accountRef: lease.address.value,
        leaseId: lease.leaseId,
        sequenceReached: next.sequenceOrNonce,
      }),
    );
    if (!released) throw refused('lease.leaseId', 'stale');
  }

  async upsertDelivery(d: LegDeliveryRecord): Promise<void> {
    const written = await this.#refusing('delivery', async () =>
      this.#db.tenant(d.scope).transaction(async (tx) =>
        legDeliveries.upsert(tx, {
          legKey: d.legKey,
          network: d.network,
          rail: d.rail,
          provider: d.provider,
          providerRef: d.providerRef,
          destinationAddress: d.destination.address.value,
          destinationTag: d.destination.tag,
          quoteId: d.quoteId,
          state: d.state,
          rawStatus: d.rawStatus,
          live: d.live,
          expiresAt: d.expiresAt === null ? null : dateOf(d.expiresAt),
          updatedAt: dateOf(d.updatedAt),
        }),
      ),
    );
    if (!written) throw refused('delivery', 'not_found');
  }

  async liveDelivery(scope: TenantScope, legKey: LegKey): Promise<LegDeliveryRecord | null> {
    const row = await this.#db
      .tenant(scope)
      .transaction(async (tx) => legDeliveries.live(tx, legKey));
    return row === undefined ? null : toDeliveryRecord(scope, row);
  }
}
