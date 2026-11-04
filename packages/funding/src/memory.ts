// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The ports in memory, for tests and for services that run with no database.
// The store holds what funding_sweeps holds: one row per chain and deposit
// operation across every tenant, only a tenant's own rows visible, the table's
// moves and no others, and failing with no ledger refused until the time bound
// is past by the margin.

import { randomUUID } from 'node:crypto';

import type {
  FundingAccountRecord,
  FundingAccountStore,
  NetworkId,
  TenantScope,
} from '@ujira/chain-adapter';
import type { FundingSweep, FundingSweepMove, NewFundingSweep } from '@ujira/db';

import { FundingAccountConflictError, SweepStateError } from './errors.js';
import type { FundingInstance, FundingSourceStore } from './funding-account.js';
import { FAILED_EXPIRY_MARGIN_MS } from './sweep.js';
import type {
  SweepFunding,
  SweepFundingRecord,
  SweepPrompt,
  SweepPrompts,
  SweepReports,
  SweepScope,
  SweepStore,
} from './sweep.js';

const MOVES: Readonly<Record<FundingSweep['status'], readonly FundingSweep['status'][]>> = {
  awaiting_signature: ['submitted', 'cancelled'],
  submitted: ['settled', 'failed'],
  failed: ['awaiting_signature'],
  settled: [],
  cancelled: [],
};

interface Stored {
  readonly scope: SweepScope;
  readonly chain: string;
  row: FundingSweep;
}

function isScope(a: SweepScope, b: SweepScope): boolean {
  return a.principalId === b.principalId && a.projectId === b.projectId;
}

export class MemorySweepStore implements SweepStore {
  /** The next setStatus throws this, as a crash before the write would. */
  failNextSetStatus: Error | null = null;
  /** The next read finds nothing, as a read just before a racing insert would. */
  hideNextRead = false;
  readonly #clock: { now(): Date };
  readonly #rows = new Map<string, Stored>();

  constructor(clock: { now(): Date }) {
    this.#clock = clock;
  }

  rowsOf(scope: SweepScope): readonly FundingSweep[] {
    return [...this.#rows.values()].filter((s) => isScope(s.scope, scope)).map((s) => s.row);
  }

  byDepositOperation(
    scope: SweepScope,
    input: { readonly chain: string; readonly depositOperationId: string },
  ): Promise<FundingSweep | undefined> {
    if (this.hideNextRead) {
      this.hideNextRead = false;
      return Promise.resolve(undefined);
    }
    const stored = this.#rows.get(`${input.chain}|${input.depositOperationId}`);
    return Promise.resolve(
      stored !== undefined && isScope(stored.scope, scope) ? stored.row : undefined,
    );
  }

  create(scope: SweepScope, input: NewFundingSweep): Promise<FundingSweep | 'duplicate'> {
    const { chain } = input.amount;
    const unique = `${chain}|${input.depositOperationId}`;
    if (this.#rows.has(unique)) return Promise.resolve('duplicate');
    const at = this.#clock.now();
    const row: FundingSweep = {
      id: randomUUID(),
      fundingSourceId: input.fundingSourceId,
      mandateInstanceId: input.mandateInstanceId,
      depositOperationId: input.depositOperationId,
      amount: input.amount,
      status: 'awaiting_signature',
      sweepTxHash: null,
      validUntil: null,
      failedLedger: null,
      createdAt: at,
      updatedAt: at,
    };
    this.#rows.set(unique, { scope, chain, row });
    return Promise.resolve(row);
  }

  setStatus(scope: SweepScope, id: string, move: FundingSweepMove): Promise<boolean> {
    if (this.failNextSetStatus !== null) {
      const error = this.failNextSetStatus;
      this.failNextSetStatus = null;
      return Promise.reject(error);
    }
    const stored = [...this.#rows.values()].find((s) => s.row.id === id && isScope(s.scope, scope));
    if (stored === undefined) return Promise.resolve(false);
    return new Promise((resolve) => {
      stored.row = this.#applied(stored.row, move);
      resolve(true);
    });
  }

  #applied(row: FundingSweep, move: FundingSweepMove): FundingSweep {
    if (!MOVES[row.status].includes(move.status)) throw new SweepStateError();
    const at = this.#clock.now();
    const updatedAt = at;
    switch (move.status) {
      case 'submitted':
        if (move.validUntil.getTime() <= at.getTime()) throw new SweepStateError();
        return {
          ...row,
          status: move.status,
          sweepTxHash: move.sweepTxHash,
          validUntil: move.validUntil,
          updatedAt,
        };
      case 'failed':
        if (
          move.failedLedger === null &&
          at.getTime() < (row.validUntil?.getTime() ?? 0) + FAILED_EXPIRY_MARGIN_MS
        ) {
          throw new SweepStateError();
        }
        return { ...row, status: move.status, failedLedger: move.failedLedger, updatedAt };
      case 'awaiting_signature':
        return {
          ...row,
          status: move.status,
          sweepTxHash: null,
          validUntil: null,
          failedLedger: null,
          updatedAt,
        };
      default:
        return { ...row, status: move.status, updatedAt };
    }
  }
}

/**
 * What funding_accounts and funding_account_sources hold: one account per
 * principal and network, no address held twice, one source per mandate instance,
 * and only an active account of this project attached to this project's instance
 * on the same network.
 */
export class MemoryFundingAccounts implements FundingAccountStore, FundingSourceStore {
  /** The next attach throws this, as a crash after the chain step would. */
  failNextAttach: Error | null = null;
  readonly #accounts = new Map<string, FundingAccountRecord>();
  readonly #instances = new Map<
    string,
    { readonly scope: TenantScope; readonly instance: FundingInstance }
  >();
  readonly #sources = new Map<string, string>();

  /** A mandate instance that exists for this tenant. */
  addInstance(scope: TenantScope, mandateInstanceId: string, instance: FundingInstance): void {
    this.#instances.set(mandateInstanceId, { scope, instance });
  }

  sources(): readonly string[] {
    return [...this.#sources.values()];
  }

  instance(scope: TenantScope, mandateInstanceId: string): Promise<FundingInstance | null> {
    const held = this.#instances.get(mandateInstanceId);
    return Promise.resolve(held !== undefined && isScope(held.scope, scope) ? held.instance : null);
  }

  forPrincipal(scope: TenantScope, network: NetworkId): Promise<FundingAccountRecord | null> {
    return Promise.resolve(this.#accounts.get(`${scope.principalId}|${network}`) ?? null);
  }

  record(row: FundingAccountRecord): Promise<void> {
    const key = `${row.principalId}|${row.network}`;
    const held = this.#accounts.get(key);
    const taken = [...this.#accounts.values()].some(
      (other) =>
        other.network === row.network &&
        other.address === row.address &&
        other.principalId !== row.principalId,
    );
    if (taken || (held !== undefined && held.address !== row.address)) {
      return Promise.reject(new FundingAccountConflictError());
    }
    if (held === undefined) this.#accounts.set(key, row);
    return Promise.resolve();
  }

  attach(
    scope: TenantScope,
    input: { readonly network: NetworkId; readonly mandateInstanceId: string },
  ): Promise<string | null> {
    if (this.failNextAttach !== null) {
      const error = this.failNextAttach;
      this.failNextAttach = null;
      return Promise.reject(error);
    }
    const account = this.#accounts.get(`${scope.principalId}|${input.network}`);
    const held = this.#instances.get(input.mandateInstanceId);
    if (
      account?.status !== 'active' ||
      account.projectId !== scope.projectId ||
      held === undefined ||
      !isScope(held.scope, scope) ||
      held.instance.network !== input.network
    ) {
      return Promise.resolve(null);
    }
    const existing = this.#sources.get(input.mandateInstanceId);
    if (existing !== undefined) return Promise.resolve(existing);
    const id = randomUUID();
    this.#sources.set(input.mandateInstanceId, id);
    return Promise.resolve(id);
  }
}

/** An outbox in miniature: a repeated idempotency key delivers nothing. */
export class RecordingSweepPrompts implements SweepPrompts {
  #attempts = 0;
  readonly #delivered = new Map<string, SweepPrompt>();

  requestSignature(prompt: SweepPrompt, idempotencyKey: string): Promise<void> {
    this.#attempts += 1;
    if (!this.#delivered.has(idempotencyKey)) this.#delivered.set(idempotencyKey, prompt);
    return Promise.resolve();
  }

  attempts(): number {
    return this.#attempts;
  }

  delivered(): readonly SweepPrompt[] {
    return [...this.#delivered.values()];
  }
}

export class RecordingSweepFunding implements SweepFunding {
  readonly #records = new Map<string, SweepFundingRecord>();

  record(record: SweepFundingRecord, key: string): Promise<void> {
    if (!this.#records.has(key)) this.#records.set(key, record);
    return Promise.resolve();
  }

  records(): readonly SweepFundingRecord[] {
    return [...this.#records.values()];
  }
}

export class RecordingSweepReports implements SweepReports {
  readonly #events: Parameters<SweepReports['sweepFailed']>[0][] = [];
  readonly #alerts: Parameters<SweepReports['transferAlert']>[0][] = [];

  sweepFailed(event: Parameters<SweepReports['sweepFailed']>[0]): void {
    this.#events.push(event);
  }

  transferAlert(event: Parameters<SweepReports['transferAlert']>[0]): void {
    this.#alerts.push(event);
  }

  events(): readonly Parameters<SweepReports['sweepFailed']>[0][] {
    return [...this.#events];
  }

  alerts(): readonly Parameters<SweepReports['transferAlert']>[0][] {
    return [...this.#alerts];
  }
}
