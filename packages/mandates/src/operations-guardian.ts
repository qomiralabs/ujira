// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The operations team's pause-only guardian. It is added to every new
// mandate unless the principal opts out, and once a principal has removed
// it from a mandate, UJIRA never puts it back: not on reconciliation, not on
// a migration, and not on a new chain instance of the same mandate. The
// principal stays the only one who decides whether it is there.
//
// The guardian's address can be rotated. Every address it ever had counts as the
// operations guardian, so a mandate still holding an old one has not lost it, and
// removing an old one is as much the principal's choice as removing the current.
// New mandates only ever get the current address.

import { operationsGuardianOf, operationsGuardiansOf } from '@ujira/chain-adapter';
import type { ChainAddress, NetworkId, NetworksConfig, RoleName } from '@ujira/chain-adapter';

import { callPort, keyText } from './ports.js';
import type { LogicalMandateKey, PortCallOptions } from './ports.js';

/**
 * What the API response and the mandate view say about the guardian. `outdated`
 * means the mandate holds an address the guardian had before a rotation. UJIRA
 * cannot change a mandate's roles, so moving to the current address is the
 * principal's to do: add it, then remove the old one.
 */
export type OperationsGuardianStatus = 'present' | 'outdated' | 'absent';

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

/** Every address the guardian has had on a network, the current one first. */
export function knownGuardians(
  deps: GuardianPolicyDeps,
  network: NetworkId,
): readonly ChainAddress[] {
  return operationsGuardiansOf(deps.networks(), network);
}

function isKnown(known: readonly ChainAddress[], address: ChainAddress): boolean {
  return known.some((guardian) => sameAddress(guardian, address));
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
  /**
   * The instance's guardians after the removal, when the indexer read them. A
   * removal that leaves another of the guardian's addresses in place is the
   * principal moving to the current address, not taking the guardian away.
   */
  readonly guardiansAfter?: readonly ChainAddress[];
}

/**
 * Called by the indexer for every role removal. Removing any address the
 * operations guardian has had is recorded against the logical mandate, so no
 * later step adds it again. Any other removal is not this rule's business.
 */
export async function onRoleRemoved(
  key: LogicalMandateKey,
  event: RoleRemoved,
  deps: GuardianPolicyDeps,
): Promise<'recorded' | 'ignored'> {
  if (event.role !== 'guardian') return 'ignored';
  const known = knownGuardians(deps, event.network);
  if (!isKnown(known, event.account)) return 'ignored';
  if (event.guardiansAfter?.some((guardian) => isKnown(known, guardian)) === true) {
    return 'ignored';
  }
  await recordOptOut(key, deps);
  return 'recorded';
}

/**
 * Reconciliation's view of the guardian. It reads what the chain holds and
 * never proposes adding anything. Only when no address the guardian ever had
 * is on chain did the principal leave it out, even if the event that said so
 * was missed, so only then is the absence recorded and the answer 'absent'.
 */
export async function reconcileOperationsGuardian(
  key: LogicalMandateKey,
  onChain: OnChainGuardians,
  deps: GuardianPolicyDeps,
): Promise<OperationsGuardianStatus> {
  const current = configuredGuardian(deps, onChain.network);
  if (current !== null && isKnown(onChain.guardians, current)) return 'present';
  const known = knownGuardians(deps, onChain.network);
  if (onChain.guardians.some((guardian) => isKnown(known, guardian))) return 'outdated';
  if (current !== null) await recordOptOut(key, deps);
  return 'absent';
}
