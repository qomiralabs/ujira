// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Turns what a principal asked for into the configuration that goes to the
// chain adapter's create action, applying UJIRA's creation rules on the way.

import type { MandateConfigInput, NetworkId } from '@ujira/chain-adapter';

import { allowsManagedAgent, assertCustodyAllowed } from './custody.js';
import type { ManagedAgentKeys } from './custody.js';
import { OperationsGuardianNotConfiguredError } from './errors.js';
import { configuredGuardian, hasOptedOut, sameAddress } from './operations-guardian.js';
import type { GuardianPolicyDeps, OperationsGuardianStatus } from './operations-guardian.js';
import { callPort, keyText } from './ports.js';
import type { LogicalMandateKey } from './ports.js';
import { assertMayCreate } from './principal-key.js';
import type { PrincipalKeyDeps, PrincipalKeyWarning } from './principal-key.js';

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
  /**
   * True when the managed agent option was chosen. Left out does not vouch
   * for anything: every agent is still looked up in the managed agent keys.
   */
  readonly managedAgent?: boolean;
}

export interface MandateCreationPlan {
  readonly network: NetworkId;
  /** What goes to the adapter's create action. */
  readonly config: MandateConfigInput;
  /** Stated in the API response and the mandate view. */
  readonly operationsGuardian: OperationsGuardianStatus;
  /** Shown by the dashboard at any budget. */
  readonly warnings: readonly PrincipalKeyWarning[];
}

export interface CreationDeps extends GuardianPolicyDeps {
  readonly managedAgents: ManagedAgentKeys;
  readonly principalKeys: PrincipalKeyDeps;
}

/** The ID one chain instance of a logical mandate has in the principal's holdings. */
export function instanceIdOf(key: LogicalMandateKey, network: NetworkId): string {
  return `${keyText(key)}@${network}`;
}

// Only a mode that forbids a managed agent needs the lookup, and a lookup
// that fails stops creation, so an outage cannot wave a mandate through.
async function holdsAgentKey(req: CreateMandateRequest, deps: CreationDeps): Promise<boolean> {
  if (req.managedAgent === true) return true;
  if (allowsManagedAgent(req.config.recipientMode)) return false;
  const scope = { principalId: req.key.principalId, projectId: req.key.projectId };
  for (const agent of req.config.agents) {
    const managed = await callPort(
      (opts) => deps.managedAgents.isManaged(scope, agent, opts),
      deps.timeoutMs,
    );
    if (managed) return true;
  }
  return false;
}

async function includeGuardian(req: CreateMandateRequest, deps: CreationDeps): Promise<boolean> {
  if (req.guardian !== undefined) return req.guardian;
  return !(await hasOptedOut(req.key, deps));
}

/**
 * Applies the creation rules and returns the configuration to create. Throws
 * CustodyGuardError for an attested only mandate with a managed agent, and
 * OperationsGuardianNotConfiguredError when the guardian should be added but
 * the network has none configured, and PrincipalKeyRiskError when the
 * principal's holdings would pass 50,000 USD without qualifying.
 */
export async function planMandateCreation(
  req: CreateMandateRequest,
  deps: CreationDeps,
): Promise<MandateCreationPlan> {
  // First, so a refused mandate never reaches the other rules.
  assertCustodyAllowed(req.config.recipientMode, await holdsAgentKey(req, deps));
  const guardian = configuredGuardian(deps, req.network);
  let guardians = req.config.guardians;
  if (await includeGuardian(req, deps)) {
    if (guardian === null) throw new OperationsGuardianNotConfiguredError();
    if (!guardians.some((g) => sameAddress(g, guardian))) guardians = [...guardians, guardian];
  }
  // Read from the final list, so the stated status always matches what goes on chain.
  const present = guardian !== null && guardians.some((g) => sameAddress(g, guardian));
  // Last, because it reads the chain, and only once the config is final.
  const { warnings } = await assertMayCreate(
    req.key.principalId,
    {
      instanceId: instanceIdOf(req.key, req.network),
      projectId: req.key.projectId,
      principal: req.config.principal,
      totalBudget: req.config.limits.totalBudget,
      recovery: req.config.recovery,
      recoveryThreshold: req.config.recoveryThreshold,
    },
    deps.principalKeys,
  );
  return Object.freeze({
    network: req.network,
    config: Object.freeze({ ...req.config, guardians: Object.freeze([...guardians]) }),
    operationsGuardian: present ? 'present' : 'absent',
    warnings,
  });
}
