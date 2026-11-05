// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Keeps one mandate's ledger entries alive. It reads each entry's
// liveUntilLedgerSeq, restores any that are archived, and extends every
// entry below the configured threshold to the configured target, with the
// fee sponsored. Thresholds and targets are configuration, never code.
//
// It runs from the queue and may be retried at any point, so every
// submission is a step claimed before it is sent: one per tenant, network,
// mandate, ledger window, action and set of keys. A retry in the same
// window finds the claim and sends nothing. Only a step that definitely
// did not land frees its claim, so a rejected extension is tried again but
// an ambiguous one is left for the next window rather than sent twice.

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { isContractAddress } from '../codecs/strkey.js';
import {
  InvalidInputError,
  RpcTimeoutError,
  SubmissionUnknownError,
  isChainAdapterError,
} from '../errors.js';
import type { ChainAdapterError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import type { TenantScope } from '../types.js';

import { keepAliveKeys } from './ttl-keys.js';
import type { KeepAliveTarget } from './ttl-keys.js';

/** An entry's time to live as RPC getLedgerEntries reports it. */
export type EntryTtl =
  | { readonly key: string; readonly state: 'live'; readonly liveUntilLedgerSeq: number }
  | { readonly key: string; readonly state: 'archived' };

/** Reads entries by ledger key. A key the network has never held is left out. */
export interface TtlReader {
  readTtl(
    network: StellarNetworkId,
    keys: readonly string[],
    signal: AbortSignal,
  ): Promise<{ readonly latestLedger: number; readonly entries: readonly EntryTtl[] }>;
}

export interface TtlSubmission {
  readonly scope: TenantScope;
  readonly network: StellarNetworkId;
  readonly mandate: string;
  /** Base64 LedgerKeys, the transaction's footprint. */
  readonly keys: readonly string[];
}

/**
 * Sends fee sponsored RestoreFootprint and ExtendFootprintTTL transactions
 * and resolves once they landed. Throws a ChainAdapterError whose `landed`
 * says whether anything may have reached the chain.
 */
export interface TtlSubmitter {
  restore(req: TtlSubmission, signal: AbortSignal): Promise<{ readonly txHash: string }>;
  extend(
    req: TtlSubmission & { readonly extendToLedgers: number },
    signal: AbortSignal,
  ): Promise<{ readonly txHash: string }>;
}

export type TtlAction = 'restore' | 'extend';

export interface TtlStep {
  readonly scope: TenantScope;
  readonly network: StellarNetworkId;
  readonly mandate: string;
  /** The latest ledger divided by the window length, rounded down. */
  readonly window: number;
  readonly action: TtlAction;
  /** SHA-256 of the sorted keys, in hex. */
  readonly keysHash: string;
}

export type TtlClaim =
  { readonly claimed: true } | { readonly claimed: false; readonly state: 'pending' | 'landed' };

/**
 * Where steps are claimed. Unique on every field of TtlStep, scope
 * included, so a tenant can never see or block another's steps.
 */
export interface TtlStepStore {
  /** Claims the step unless it is pending or landed. A failed step is claimed again. */
  claim(step: TtlStep): Promise<TtlClaim>;
  settle(
    step: TtlStep,
    outcome: { readonly state: 'landed'; readonly txHash: string } | { readonly state: 'failed' },
  ): Promise<void>;
}

export const TTL_METRICS = Object.freeze([
  'ttl_entries_below_threshold',
  'ttl_archived_entries_found',
  'ttl_entries_missing',
  'ttl_extension_failed',
] as const);

export type TtlMetricName = (typeof TTL_METRICS)[number];

export interface TtlMetricLabels {
  readonly principalId: string;
  readonly projectId: string;
  readonly network: StellarNetworkId;
}

/** Counters the alerting reads. Every label set names its tenant. */
export interface TtlMetrics {
  increment(name: TtlMetricName, labels: TtlMetricLabels, by: number): void;
}

export interface TtlPorts {
  readonly reader: TtlReader;
  readonly submitter: TtlSubmitter;
  readonly store: TtlStepStore;
  readonly metrics: TtlMetrics;
}

export interface TtlKeepAliveJob {
  readonly scope: TenantScope;
  readonly network: StellarNetworkId;
  readonly target: KeepAliveTarget;
}

export interface TtlKeepAliveResult {
  readonly window: number;
  readonly checked: number;
  readonly belowThreshold: number;
  readonly archived: number;
  readonly missing: number;
  readonly restored: number;
  readonly extended: number;
  /** Steps a previous attempt in this window already sent. */
  readonly alreadySubmitted: number;
  /** Archived entries not extended because their restore is unresolved. */
  readonly waitingOnRestore: number;
}

// About 180 days of ledgers, the most the network lets an entry live.
const MAX_EXTEND_TO_LEDGERS = 3_110_400;
// RPC getLedgerEntries reads at most this many keys a call.
const MAX_KEYS_PER_READ = 200;

const configSchema = z
  .strictObject({
    /** An entry with fewer ledgers left than this is extended. */
    thresholdLedgers: z.int().min(1).max(MAX_EXTEND_TO_LEDGERS),
    /** How many ledgers from now an extended entry lives. */
    extendToLedgers: z.int().min(2).max(MAX_EXTEND_TO_LEDGERS),
    /** Ledgers per idempotency window; a step is sent at most once in each. */
    windowLedgers: z.int().min(1).max(MAX_EXTEND_TO_LEDGERS),
    /** Footprint size of one restore or extension. */
    maxKeysPerTransaction: z.int().min(1).max(100),
    rpcTimeoutMs: z.int().min(1).max(120_000),
    submitTimeoutMs: z.int().min(1).max(600_000),
  })
  .refine((c) => c.extendToLedgers > c.thresholdLedgers, { path: ['extendToLedgers'] });

export type TtlConfig = z.infer<typeof configSchema>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const payloadSchema = z.strictObject({
  principalId: z.string().regex(UUID),
  projectId: z.string().regex(UUID),
  network: z.enum(['stellar:pubnet', 'stellar:testnet']),
  mandateRef: z.string().refine(isContractAddress),
});

export type TtlKeepAlivePayload = z.infer<typeof payloadSchema>;

function issuesOf(error: z.ZodError, root: string): InvalidInputError {
  return new InvalidInputError({
    issues: error.issues
      .slice(0, 10)
      .map((issue) => `${[root, ...issue.path.map(String)].join('.')} (${issue.code})`),
  });
}

/** Validates keep-alive configuration. Throws InvalidInputError naming fields only. */
export function parseTtlConfig(input: unknown): TtlConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw issuesOf(parsed.error, 'ttlConfig');
  return Object.freeze(parsed.data);
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size));
  return out;
}

function hashKeys(keys: readonly string[]): string {
  return createHash('sha256')
    .update([...keys].sort().join('\n'))
    .digest('hex');
}

// Gives up at the deadline even if the port ignores the signal.
async function withDeadline<T>(
  timeoutMs: number,
  onTimeout: () => ChainAdapterError,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(onTimeout());
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

interface RunContext {
  readonly job: TtlKeepAliveJob;
  readonly config: TtlConfig;
  readonly ports: TtlPorts;
  readonly labels: TtlMetricLabels;
  readonly window: number;
}

type StepResult = 'sent' | 'already';

async function runStep(
  ctx: RunContext,
  action: TtlAction,
  keys: readonly string[],
): Promise<StepResult> {
  const { job, config, ports } = ctx;
  const step: TtlStep = {
    scope: job.scope,
    network: job.network,
    mandate: job.target.mandate,
    window: ctx.window,
    action,
    keysHash: hashKeys(keys),
  };
  const claim = await ports.store.claim(step);
  if (!claim.claimed) return 'already';
  const req: TtlSubmission = {
    scope: job.scope,
    network: job.network,
    mandate: job.target.mandate,
    keys,
  };
  try {
    const { txHash } = await withDeadline(
      config.submitTimeoutMs,
      () => new RpcTimeoutError({ network: job.network }),
      (signal) =>
        action === 'restore'
          ? ports.submitter.restore(req, signal)
          : ports.submitter.extend({ ...req, extendToLedgers: config.extendToLedgers }, signal),
    );
    await ports.store.settle(step, { state: 'landed', txHash });
    return 'sent';
  } catch (err) {
    ports.metrics.increment('ttl_extension_failed', ctx.labels, 1);
    const error = isChainAdapterError(err)
      ? err
      : new SubmissionUnknownError({ network: job.network, cause: err });
    // Only a definite miss frees the step; anything that may have landed
    // stays claimed so no retry sends it twice.
    if (error.landed === 'no') await ports.store.settle(step, { state: 'failed' });
    throw error;
  }
}

/**
 * One keep-alive pass over a mandate. Throws the adapter's typed errors: a
 * read that times out is RpcTimeoutError with nothing sent, and a failed
 * submission is rethrown after its step is recorded, so the queue's bounded
 * retries and dead letter path see it.
 */
export async function runTtlKeepAlive(
  job: TtlKeepAliveJob,
  config: TtlConfig,
  ports: TtlPorts,
): Promise<TtlKeepAliveResult> {
  const keys = keepAliveKeys(job.target).map((k) => k.xdr);
  const labels: TtlMetricLabels = {
    principalId: job.scope.principalId,
    projectId: job.scope.projectId,
    network: job.network,
  };
  let latestLedger = 0;
  const entries = new Map<string, EntryTtl>();
  for (const part of chunks(keys, MAX_KEYS_PER_READ)) {
    const read = await withDeadline(
      config.rpcTimeoutMs,
      () => new RpcTimeoutError({ network: job.network, landed: 'no' }),
      (signal) => ports.reader.readTtl(job.network, part, signal),
    );
    latestLedger = Math.max(latestLedger, read.latestLedger);
    for (const entry of read.entries) entries.set(entry.key, entry);
  }
  const archived = keys.filter((k) => entries.get(k)?.state === 'archived');
  const missing = keys.filter((k) => !entries.has(k));
  const lapsing = keys.filter((k) => {
    const entry = entries.get(k);
    return (
      entry?.state === 'live' && entry.liveUntilLedgerSeq - latestLedger < config.thresholdLedgers
    );
  });
  if (lapsing.length > 0)
    ports.metrics.increment('ttl_entries_below_threshold', labels, lapsing.length);
  if (archived.length > 0)
    ports.metrics.increment('ttl_archived_entries_found', labels, archived.length);
  if (missing.length > 0) ports.metrics.increment('ttl_entries_missing', labels, missing.length);

  const ctx: RunContext = {
    job,
    config,
    ports,
    labels,
    window: Math.floor(latestLedger / config.windowLedgers),
  };
  let restored = 0;
  let extended = 0;
  let alreadySubmitted = 0;
  let waitingOnRestore = 0;
  const restoredKeys: string[] = [];
  for (const part of chunks(archived, config.maxKeysPerTransaction)) {
    const outcome = await runStep(ctx, 'restore', part);
    if (outcome === 'sent') {
      restored += part.length;
      restoredKeys.push(...part);
    } else {
      // Restored by an earlier attempt if it landed; otherwise still
      // archived, and extending an archived entry would only fail.
      alreadySubmitted += 1;
      waitingOnRestore += part.length;
    }
  }
  const toExtend = [...lapsing, ...restoredKeys];
  for (const part of chunks(toExtend, config.maxKeysPerTransaction)) {
    const outcome = await runStep(ctx, 'extend', part);
    if (outcome === 'sent') extended += part.length;
    else alreadySubmitted += 1;
  }
  return Object.freeze({
    window: ctx.window,
    checked: keys.length,
    belowThreshold: lapsing.length,
    archived: archived.length,
    missing: missing.length,
    restored,
    extended,
    alreadySubmitted,
    waitingOnRestore,
  });
}

/** Loads what to keep alive for a mandate from the tenant's own records. */
export interface KeepAliveTargets {
  load(scope: TenantScope, network: StellarNetworkId, mandate: string): Promise<KeepAliveTarget>;
}

/**
 * The queue task. Its name and job key are fixed so one queued job per
 * tenant and mandate can exist at a time; attempts and the dead letter
 * path are the queue's. The name has a colon, because the queue and the crontab
 * parser refuse a dot, and the key names no tenant, because the queue puts the
 * tenant in front of every key itself.
 */
export const TTL_KEEP_ALIVE_TASK = Object.freeze({
  name: 'ttl:keep_alive',
  jobKey: (payload: Pick<TtlKeepAlivePayload, 'network' | 'mandateRef'>): string =>
    `ttl:${payload.network}:${payload.mandateRef}`,
});

/** The task handler: validates the payload, loads the target and runs one pass. */
export function ttlKeepAliveTask(
  deps: TtlPorts & { readonly config: TtlConfig; readonly targets: KeepAliveTargets },
): (payload: unknown) => Promise<void> {
  return async (payload) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) throw issuesOf(parsed.error, 'payload');
    const { principalId, projectId, network, mandateRef: mandate } = parsed.data;
    const scope = { principalId, projectId } as TenantScope;
    const target = await deps.targets.load(scope, network, mandate);
    // A loader bug must not keep another mandate alive on this tenant's budget.
    if (target.mandate !== mandate) {
      throw new InvalidInputError({ issues: ['target.mandate (mismatch)'] });
    }
    await runTtlKeepAlive({ scope, network, target }, deps.config, deps);
  };
}
