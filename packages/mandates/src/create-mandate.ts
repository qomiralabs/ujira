// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Turns what a principal asked for into the configuration that goes to the
// chain adapter's create action, applying UJIRA's creation rules on the way.

import type { MandateConfigInput, NetworkId } from '@ujira/chain-adapter';

import { assertCustodyAllowed } from './custody.js';
import { OperationsGuardianNotConfiguredError } from './errors.js';
import { configuredGuardian, hasOptedOut, sameAddress } from './operations-guardian.js';
import type { GuardianPolicyDeps, OperationsGuardianStatus } from './operations-guardian.js';
import type { LogicalMandateKey } from './ports.js';

export interface CreateMandateRequest {
  readonly key: LogicalMandateKey;
  readonly network: NetworkId;
  /** The principal's configuration; `guardians` holds only the principal's own choices. */
  readonly config: MandateConfigInput;
  /**
   * The request's `guardian` field. Left out, the operations guardian is
   * included, unless the principal removed it from this logical mandate
   * before. false leaves it out; true includes it even then, because that
   * is the principal choosing, not UJIRA re-adding.
   */
  readonly guardian?: boolean;
  /** True when one of the agents is a key UJIRA holds for the principal. */
  readonly managedAgent?: boolean;
}

export interface MandateCreationPlan {
  readonly network: NetworkId;
  /** What goes to the adapter's create action. */
  readonly config: MandateConfigInput;
  /** Stated in the API response and the mandate view. */
  readonly operationsGuardian: OperationsGuardianStatus;
}

export type CreationDeps = GuardianPolicyDeps;

async function includeGuardian(req: CreateMandateRequest, deps: CreationDeps): Promise<boolean> {
  if (req.guardian !== undefined) return req.guardian;
  return !(await hasOptedOut(req.key, deps));
}

/**
 * Applies the creation rules and returns the configuration to create. Throws
 * CustodyGuardError for an attested only mandate with a managed agent, and
 * OperationsGuardianNotConfiguredError when the guardian should be added but
 * the network has none configured.
 */
export async function planMandateCreation(
  req: CreateMandateRequest,
  deps: CreationDeps,
): Promise<MandateCreationPlan> {
  // First, and before any store is read: this refusal never depends on state.
  assertCustodyAllowed(req.config.recipientMode, req.managedAgent === true);
  const guardian = configuredGuardian(deps, req.network);
  let guardians = req.config.guardians;
  if (await includeGuardian(req, deps)) {
    if (guardian === null) throw new OperationsGuardianNotConfiguredError();
    if (!guardians.some((g) => sameAddress(g, guardian))) guardians = [...guardians, guardian];
  }
  // Read from the final list, so the stated status always matches what goes on chain.
  const present = guardian !== null && guardians.some((g) => sameAddress(g, guardian));
  return Object.freeze({
    network: req.network,
    config: Object.freeze({ ...req.config, guardians: Object.freeze([...guardians]) }),
    operationsGuardian: present ? 'present' : 'absent',
  });
}
