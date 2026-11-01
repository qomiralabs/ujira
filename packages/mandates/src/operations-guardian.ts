// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The operations team's pause-only guardian. It is added to every new
// mandate unless the principal opts out, and once a principal has removed
// it from a mandate, UJIRA never puts it back: not on reconciliation, not on
// a migration, and not on a new chain instance of the same mandate. The
// principal stays the only one who decides whether it is there.

import { operationsGuardianOf } from '@ujira/chain-adapter';
import type { ChainAddress, NetworkId, NetworksConfig, RoleName } from '@ujira/chain-adapter';

import { callPort, keyText } from './ports.js';
import type { LogicalMandateKey, PortCallOptions } from './ports.js';

/** What the API response and the mandate view say about the guardian. */
export type OperationsGuardianStatus = 'present' | 'absent';

/**
 * Logical mandates whose principal left the operations guardian out, at
 * creation or later. Writes are idempotent and nothing ever deletes a
 * record, because deleting one is how the guardian would come back.
 */
export interface GuardianOptOutStore {
  recordOptOut(key: LogicalMandateKey, opts: PortCallOptions): Promise<void>;
  hasOptedOut(key: LogicalMandateKey, opts: PortCallOptions): Promise<boolean>;
}

export interface GuardianPolicyDeps {
  /** The current validated networks configuration. */
  readonly networks: () => NetworksConfig;
  readonly optOuts: GuardianOptOutStore;
  /** Bound on each store call. */
  readonly timeoutMs?: number;
}

export function createMemoryGuardianOptOutStore(): GuardianOptOutStore {
  const optedOut = new Set<string>();
  return {
    recordOptOut(key) {
      optedOut.add(keyText(key));
      return Promise.resolve();
    },
    hasOptedOut(key) {
      return Promise.resolve(optedOut.has(keyText(key)));
    },
  };
}

export function sameAddress(a: ChainAddress, b: ChainAddress): boolean {
  return a.network === b.network && a.value === b.value;
}

/** The configured guardian for a network, read fresh from the current configuration. */
export function configuredGuardian(
  deps: GuardianPolicyDeps,
  network: NetworkId,
): ChainAddress | null {
  return operationsGuardianOf(deps.networks(), network);
}

export function hasOptedOut(key: LogicalMandateKey, deps: GuardianPolicyDeps): Promise<boolean> {
  return callPort((opts) => deps.optOuts.hasOptedOut(key, opts), deps.timeoutMs);
}

function recordOptOut(key: LogicalMandateKey, deps: GuardianPolicyDeps): Promise<void> {
  return callPort((opts) => deps.optOuts.recordOptOut(key, opts), deps.timeoutMs);
}

/** The guardian set of one chain instance, as read from its config(). */
export interface OnChainGuardians {
  readonly network: NetworkId;
  readonly guardians: readonly ChainAddress[];
}

/** A role removal the indexer read from a mandate's events. */
export interface RoleRemoved {
  readonly network: NetworkId;
  readonly role: RoleName;
  readonly account: ChainAddress;
}

/**
 * Called by the indexer for every role removal. Removing the operations
 * guardian is recorded against the logical mandate, so no later step adds
 * it again. Any other removal is not this rule's business.
 */
export async function onRoleRemoved(
  key: LogicalMandateKey,
  event: RoleRemoved,
  deps: GuardianPolicyDeps,
): Promise<'recorded' | 'ignored'> {
  if (event.role !== 'guardian') return 'ignored';
  const guardian = configuredGuardian(deps, event.network);
  if (guardian === null || !sameAddress(guardian, event.account)) return 'ignored';
  await recordOptOut(key, deps);
  return 'recorded';
}

/**
 * Reconciliation's view of the guardian. It reads what the chain holds and
 * never proposes adding anything: a guardian missing on chain means the
 * principal left it out, even if the event that said so was missed, so the
 * absence is recorded and the answer is 'absent'.
 */
export async function reconcileOperationsGuardian(
  key: LogicalMandateKey,
  onChain: OnChainGuardians,
  deps: GuardianPolicyDeps,
): Promise<OperationsGuardianStatus> {
  const guardian = configuredGuardian(deps, onChain.network);
  if (guardian !== null && onChain.guardians.some((g) => sameAddress(g, guardian))) {
    return 'present';
  }
  if (guardian !== null) await recordOptOut(key, deps);
  return 'absent';
}
