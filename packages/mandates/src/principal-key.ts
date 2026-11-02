// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// If a single key principal loses its key, nobody can pause, revoke or
// rescue the funds. Above 50,000 USD that risk is not acceptable, so the
// principal must be a multisig that needs at least two signatures, or the
// mandate must have a recovery set with a threshold of at least two. The
// contract cannot price in USD, so this rule lives here. What the chain says
// about a principal comes through a port, because reading it is the
// adapter's job.

import { compare, money, rescale, sum, tokenToUsd } from '@ujira/core';
import type { Money, TokenAmount } from '@ujira/core';
import type { ChainAddress, Uuid } from '@ujira/chain-adapter';

import { PrincipalKeyRiskError } from './errors.js';
import { callPort } from './ports.js';
import type { PortCallOptions } from './ports.js';

/** At exactly this budget a single key is still allowed; one unit above is not. */
export const PRINCIPAL_KEY_LIMIT: Money = money('5000000', 'USD');

const MIN_SIGNATURES = 2;
const MIN_RECOVERY_THRESHOLD = 2;

/** What the chain says about how a principal signs. */
export type PrincipalSigning =
  | { readonly kind: 'single_key' }
  /** The fewest signatures that can authorize a mandate call, as read on chain. */
  | { readonly kind: 'multisig'; readonly minSignatures: number }
  /** A contract wallet of a type with no reader. It never qualifies. */
  | { readonly kind: 'unverified' };

export interface PrincipalReadOptions extends PortCallOptions {
  /** True skips any cache. Set for creation and every limit change. */
  readonly fresh: boolean;
}

export interface PrincipalKeyReader {
  read(
    principalId: Uuid,
    principal: ChainAddress,
    opts: PrincipalReadOptions,
  ): Promise<PrincipalSigning>;
}

/** One chain instance of a mandate, from its config() or as a change would leave it. */
export interface InstanceView {
  /** Opaque and stable; identifies the instance within the principal's holdings. */
  readonly instanceId: string;
  readonly projectId: Uuid;
  readonly principal: ChainAddress;
  readonly totalBudget: TokenAmount;
  readonly recovery: readonly ChainAddress[];
  readonly recoveryThreshold: number;
}

/**
 * Every live instance a principal holds, across all their projects and
 * mandates. Keyed by principal and not by project, because splitting a
 * budget across projects must not get under the line.
 */
export interface PrincipalInstances {
  list(principalId: Uuid, opts: PortCallOptions): Promise<readonly InstanceView[]>;
}

export interface PrincipalKeyDeps {
  readonly instances: PrincipalInstances;
  readonly signing: PrincipalKeyReader;
  /** Bound on each port call. */
  readonly timeoutMs?: number;
}

export type PrincipalKeyWarning = 'single_key_principal' | 'unverified_principal';

export interface PrincipalKeyVerdict {
  readonly allowed: boolean;
  /** The sum over every instance, in USD at par. */
  readonly logicalBudget: Money;
  readonly aboveLimit: boolean;
  readonly warnings: readonly PrincipalKeyWarning[];
  /** Instances that do not qualify, reported whatever the budget. */
  readonly unqualified: readonly string[];
}

/** The sum of the budgets in USD at par, exact: nothing is rounded. */
export function logicalBudgetUsd(budgets: readonly TokenAmount[]): Money {
  if (budgets.length === 0) return money('0', 'USD');
  const amounts = budgets.map(tokenToUsd);
  // Scaling up is exact, so the rounding mode the call requires never applies.
  const scale = Math.max(...amounts.map((m) => m.scale));
  return sum(amounts.map((m) => rescale(m, scale, 'trunc')));
}

export function isAboveLimit(total: Money): boolean {
  const scale = Math.max(total.scale, PRINCIPAL_KEY_LIMIT.scale);
  return compare(rescale(total, scale, 'trunc'), rescale(PRINCIPAL_KEY_LIMIT, scale, 'trunc')) > 0;
}

function qualifies(instance: InstanceView, signing: PrincipalSigning): boolean {
  if (signing.kind === 'multisig' && signing.minSignatures >= MIN_SIGNATURES) return true;
  return instance.recovery.length > 0 && instance.recoveryThreshold >= MIN_RECOVERY_THRESHOLD;
}

function warningFor(signing: PrincipalSigning): PrincipalKeyWarning | null {
  if (signing.kind === 'unverified') return 'unverified_principal';
  if (signing.kind === 'single_key') return 'single_key_principal';
  return signing.minSignatures >= MIN_SIGNATURES ? null : 'single_key_principal';
}

async function readSigning(
  principalId: Uuid,
  principal: ChainAddress,
  fresh: boolean,
  deps: PrincipalKeyDeps,
): Promise<PrincipalSigning> {
  return callPort(
    (opts) => deps.signing.read(principalId, principal, { ...opts, fresh }),
    deps.timeoutMs,
  );
}

/**
 * Applies the rule to everything the principal holds, with `proposed` taking
 * the place of its current instance if it has one.
 */
export async function checkPrincipalKeyRule(
  principalId: Uuid,
  proposed: InstanceView,
  deps: PrincipalKeyDeps,
): Promise<PrincipalKeyVerdict> {
  const current = await callPort((opts) => deps.instances.list(principalId, opts), deps.timeoutMs);
  const instances = [...current.filter((i) => i.instanceId !== proposed.instanceId), proposed];
  return evaluateInstances(principalId, instances, deps);
}

/**
 * The rule over one set of instances. Every instance must qualify once the
 * total is above the line, and the chain is read afresh.
 */
export async function evaluateInstances(
  principalId: Uuid,
  instances: readonly InstanceView[],
  deps: PrincipalKeyDeps,
): Promise<PrincipalKeyVerdict> {
  const logicalBudget = logicalBudgetUsd(instances.map((i) => i.totalBudget));
  const aboveLimit = isAboveLimit(logicalBudget);
  const warnings = new Set<PrincipalKeyWarning>();
  const unqualified: string[] = [];
  const read = new Map<string, PrincipalSigning>();
  for (const instance of instances) {
    const at = JSON.stringify([instance.principal.network, instance.principal.value]);
    const signing =
      read.get(at) ?? (await readSigning(principalId, instance.principal, true, deps));
    read.set(at, signing);
    const warning = warningFor(signing);
    if (warning !== null) warnings.add(warning);
    if (!qualifies(instance, signing)) unqualified.push(instance.instanceId);
  }
  return Object.freeze({
    allowed: !aboveLimit || unqualified.length === 0,
    logicalBudget,
    aboveLimit,
    warnings: Object.freeze([...warnings]),
    unqualified: Object.freeze(unqualified),
  });
}

/** For creation. Returns the verdict for its warnings, or throws PrincipalKeyRiskError. */
export async function assertMayCreate(
  principalId: Uuid,
  proposed: InstanceView,
  deps: PrincipalKeyDeps,
): Promise<PrincipalKeyVerdict> {
  const verdict = await checkPrincipalKeyRule(principalId, proposed, deps);
  if (!verdict.allowed) throw new PrincipalKeyRiskError(verdict.unqualified);
  return verdict;
}

/**
 * For a budget change. Lowering a budget is always allowed, even above the
 * line, because it moves toward complying. Raising it runs the full rule.
 */
export async function assertMayChangeBudget(
  principalId: Uuid,
  proposed: InstanceView,
  deps: PrincipalKeyDeps,
): Promise<PrincipalKeyVerdict> {
  const current = await callPort((opts) => deps.instances.list(principalId, opts), deps.timeoutMs);
  const before = current.find((i) => i.instanceId === proposed.instanceId);
  const raising = before === undefined || compare(proposed.totalBudget, before.totalBudget) > 0;
  const verdict = await checkPrincipalKeyRule(principalId, proposed, deps);
  if (raising && !verdict.allowed) throw new PrincipalKeyRiskError(verdict.unqualified);
  return verdict;
}

/**
 * The warning the dashboard shows at any budget. May answer from a cache,
 * since it only informs; the gates above always read the chain.
 */
export async function principalKeyWarning(
  principalId: Uuid,
  principal: ChainAddress,
  deps: PrincipalKeyDeps,
): Promise<PrincipalKeyWarning | null> {
  return warningFor(await readSigning(principalId, principal, false, deps));
}

/** Remembers answers briefly, per principal. A fresh read refreshes the entry. */
export function cachePrincipalKeyReader(
  reader: PrincipalKeyReader,
  options: { readonly ttlMs?: number; readonly now?: () => number } = {},
): PrincipalKeyReader {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { readonly signing: PrincipalSigning; readonly at: number }>();
  return {
    async read(principalId, principal, opts) {
      const key = JSON.stringify([principalId, principal.network, principal.value]);
      const entry = entries.get(key);
      if (!opts.fresh && entry !== undefined && now() - entry.at < ttlMs) return entry.signing;
      const signing = await reader.read(principalId, principal, opts);
      entries.set(key, { signing, at: now() });
      return signing;
    },
  };
}

export function createMemoryPrincipalInstances(): PrincipalInstances & {
  put(principalId: Uuid, instance: InstanceView): void;
} {
  const held = new Map<string, Map<string, InstanceView>>();
  return {
    list(principalId) {
      return Promise.resolve([...(held.get(principalId)?.values() ?? [])]);
    },
    put(principalId, instance) {
      const instances = held.get(principalId) ?? new Map<string, InstanceView>();
      instances.set(instance.instanceId, instance);
      held.set(principalId, instances);
    },
  };
}

/** Answers single_key for any address not set otherwise, as a plain account would. */
export function createMemoryPrincipalKeyReader(): PrincipalKeyReader & {
  set(principal: ChainAddress, signing: PrincipalSigning): void;
} {
  const known = new Map<string, PrincipalSigning>();
  const keyOf = (a: ChainAddress): string => JSON.stringify([a.network, a.value]);
  return {
    read(_principalId, principal) {
      return Promise.resolve(known.get(keyOf(principal)) ?? { kind: 'single_key' });
    },
    set(principal, signing) {
      known.set(keyOf(principal), signing);
    },
  };
}
