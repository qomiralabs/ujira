// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// UJIRA runs the attester. If it also held the agent key of a mandate in
// attested only mode, one compromise of its signing path could both request
// a payout and vouch for any destination. So a mandate with a UJIRA held
// agent key must be in allowlist or both mode, where the principal's own
// allowlist always binds the destination. The rule is checked at creation,
// when a managed agent is added, and again by the signer before it signs.

import { SignerDeniedError, SignerUnavailableError } from '@ujira/chain-adapter';
import type {
  CallOptions,
  ChainAddress,
  MandateConfigInput,
  SignatureResult,
  SignPayload,
  SignerProvider,
  SignerRef,
  TenantScope,
  Uuid,
} from '@ujira/chain-adapter';

import { CustodyGuardError } from './errors.js';
import { callPort } from './ports.js';
import type { PortCallOptions } from './ports.js';

export type RecipientMode = MandateConfigInput['recipientMode'];

const ALL_MODES: readonly RecipientMode[] = Object.freeze(['allowlist', 'attested', 'both']);
const MANAGED_AGENT_MODES: readonly RecipientMode[] = Object.freeze(['allowlist', 'both']);

/** Whether a mandate in this mode may have an agent key UJIRA holds. */
export function allowsManagedAgent(mode: RecipientMode): boolean {
  return MANAGED_AGENT_MODES.includes(mode);
}

/** The recipient modes a creation form may offer, given the agent choice. */
export function recipientModesOffered(managedAgent: boolean): readonly RecipientMode[] {
  return managedAgent ? MANAGED_AGENT_MODES : ALL_MODES;
}

/** Throws CustodyGuardError when a managed agent is asked for in a mode that does not allow one. */
export function assertCustodyAllowed(mode: RecipientMode, managedAgent: boolean): void {
  if (managedAgent && !allowsManagedAgent(mode)) throw new CustodyGuardError();
}

/**
 * Before a UJIRA held agent key is added to an existing mandate. The mode is
 * read from the mandate's config() on chain, never from UJIRA's own records,
 * and it can never change, so a refusal means a new mandate is needed.
 */
export function assertMayAddManagedAgent(onChain: { readonly recipientMode: RecipientMode }): void {
  assertCustodyAllowed(onChain.recipientMode, true);
}

/**
 * The agent addresses UJIRA holds keys for, per tenant. Creation asks this
 * rather than trusting the request alone, so naming a managed key's address
 * as if it were the principal's own does not get past the guard.
 */
export interface ManagedAgentKeys {
  isManaged(scope: TenantScope, agent: ChainAddress, opts: PortCallOptions): Promise<boolean>;
}

export function createMemoryManagedAgentKeys(): ManagedAgentKeys & {
  add(scope: TenantScope, agent: ChainAddress): void;
} {
  const held = new Set<string>();
  const keyOf = (scope: TenantScope, agent: ChainAddress): string =>
    JSON.stringify([scope.principalId, scope.projectId, agent.network, agent.value]);
  return {
    isManaged(scope, agent) {
      return Promise.resolve(held.has(keyOf(scope, agent)));
    },
    add(scope, agent) {
      held.add(keyOf(scope, agent));
    },
  };
}

/** The recipient modes of every mandate a managed agent key is seated on. */
export interface ManagedAgentMandates {
  recipientModesOf(
    scope: TenantScope,
    agentId: Uuid,
    opts: PortCallOptions,
  ): Promise<readonly RecipientMode[]>;
}

export interface CustodyGuardDeps {
  readonly mandates: ManagedAgentMandates;
  /** Bound on the lookup. */
  readonly timeoutMs?: number;
}

/**
 * Wraps the signer so a managed agent key never signs while it is seated on
 * an attested only mandate. The check is per key, not per payload: a key on
 * one such mandate is refused for every mandate, because the payload alone
 * does not prove which mandate it acts on. A lookup that fails or times out
 * refuses too, as SignerUnavailableError, so an outage never opens the gate.
 */
export function withCustodyGuard(signer: SignerProvider, deps: CustodyGuardDeps): SignerProvider {
  const guard = async (ref: SignerRef): Promise<void> => {
    if (ref.kind !== 'managed_agent') return;
    let modes: readonly RecipientMode[];
    try {
      modes = await callPort(
        (opts) => deps.mandates.recipientModesOf(ref.scope, ref.agentId, opts),
        deps.timeoutMs,
      );
    } catch (cause) {
      throw new SignerUnavailableError({ network: ref.network, cause });
    }
    if (!modes.every(allowsManagedAgent)) throw new SignerDeniedError({ network: ref.network });
  };
  return {
    async sign(ref: SignerRef, payload: SignPayload, opts: CallOptions): Promise<SignatureResult> {
      await guard(ref);
      return signer.sign(ref, payload, opts);
    },
    address: (ref, opts) => signer.address(ref, opts),
    health: (opts) => signer.health(opts),
  };
}

export function createMemoryManagedAgentMandates(): ManagedAgentMandates & {
  seat(scope: TenantScope, agentId: Uuid, mode: RecipientMode): void;
} {
  const seats = new Map<string, RecipientMode[]>();
  const keyOf = (scope: TenantScope, agentId: Uuid): string =>
    JSON.stringify([scope.principalId, scope.projectId, agentId]);
  return {
    recipientModesOf(scope, agentId) {
      return Promise.resolve([...(seats.get(keyOf(scope, agentId)) ?? [])]);
    },
    seat(scope, agentId, mode) {
      const key = keyOf(scope, agentId);
      seats.set(key, [...(seats.get(key) ?? []), mode]);
    },
  };
}
