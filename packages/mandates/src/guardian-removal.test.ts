// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for a removed operations guardian (operations-guardian.ts).
 *
 * - onRoleRemoved records a removal of the configured operations guardian
 *   against the logical mandate and ignores every other removal.
 * - reconcileOperationsGuardian reports what the chain holds and never
 *   adds anything. A guardian missing on chain is recorded as the
 *   principal's choice, so a missed event changes nothing.
 * - Once recorded, a new chain instance of the same logical mandate is
 *   planned without the guardian.
 * - Store calls are bounded by a timeout and fail with typed errors.
 */

import { describe, expect, it } from 'vitest';

import type { RoleName } from '@ujira/chain-adapter';
import { ROLE } from '@ujira/chain-adapter/testing';
import type { EngineEvent } from '@ujira/chain-adapter/testing';

import {
  NETWORK,
  OPS_GUARDIAN,
  OWN_GUARDIAN,
  PRINCIPAL,
  at,
  createOnChain,
  key,
  networks,
  onChainGuardians,
  principalConfig,
  world,
} from '../test/world.js';
import {
  PolicyStoreError,
  PolicyStoreTimeoutError,
  createMemoryGuardianOptOutStore,
  createMemoryManagedAgentKeys,
  onRoleRemoved,
  planMandateCreation,
  reconcileOperationsGuardian,
} from './index.js';
import type { CreationDeps, GuardianOptOutStore, GuardianPolicyDeps } from './index.js';

const OPTS = { signal: new AbortController().signal };

// The indexer's decoding of a role code, as the contract numbers them.
const ROLE_NAMES: Readonly<Record<number, RoleName>> = {
  [ROLE.AGENT]: 'agent',
  [ROLE.APPROVER]: 'approver',
  [ROLE.GUARDIAN]: 'guardian',
  [ROLE.EXECUTOR]: 'executor',
  [ROLE.RECOVERY]: 'recovery',
};

function removals(events: readonly EngineEvent[]) {
  return events
    .filter((e) => e.name === 'role_removed')
    .map((e) => {
      const { role, account } = e.fields;
      if (typeof account !== 'string') throw new Error('role_removed without an account');
      return { network: NETWORK, role: ROLE_NAMES[Number(role)] ?? 'agent', account: at(account) };
    });
}

function deps(store: GuardianOptOutStore = createMemoryGuardianOptOutStore()): CreationDeps {
  return {
    networks: () => networks(),
    optOuts: store,
    managedAgents: createMemoryManagedAgentKeys(),
  };
}

async function mandateWithGuardian(d: CreationDeps) {
  const w = world();
  const plan = await planMandateCreation(
    { key: key(), network: NETWORK, config: principalConfig() },
    d,
  );
  return { w, mandate: createOnChain(w, plan.config) };
}

describe('guardian-removal', () => {
  it('reconciliation after removal does not re-add the guardian', async () => {
    const d = deps();
    const { w, mandate } = await mandateWithGuardian(d);
    expect(await reconcileOperationsGuardian(key(), onChainGuardians(mandate), d)).toBe('present');

    // The principal removes it on chain; the indexer sees the event.
    mandate.removeRole({ caller: PRINCIPAL }, ROLE.GUARDIAN, OPS_GUARDIAN);
    const [removed] = removals(w.ledger.events);
    if (removed === undefined) throw new Error('expected a role_removed event');
    expect(await onRoleRemoved(key(), removed, d)).toBe('recorded');

    const before = w.ledger.events.length;
    expect(await reconcileOperationsGuardian(key(), onChainGuardians(mandate), d)).toBe('absent');
    // Nothing was sent to the chain and the guardian is still gone.
    expect(w.ledger.events).toHaveLength(before);
    expect(mandate.config().guardians).toEqual([]);

    // A recreated instance of the same logical mandate stays without it.
    const again = await planMandateCreation(
      { key: key(), network: NETWORK, config: principalConfig() },
      d,
    );
    expect(again.operationsGuardian).toBe('absent');
  });

  it('treats a guardian missing on chain as removed even when the event was missed', async () => {
    const d = deps();
    const { mandate } = await mandateWithGuardian(d);
    mandate.removeRole({ caller: PRINCIPAL }, ROLE.GUARDIAN, OPS_GUARDIAN);
    expect(await reconcileOperationsGuardian(key(), onChainGuardians(mandate), d)).toBe('absent');
    expect(await d.optOuts.hasOptedOut(key(), OPTS)).toBe(true);
  });

  it('ignores removals of other roles and of the principal own guardians', async () => {
    const d = deps();
    const guardian = { network: NETWORK, role: 'guardian' as const, account: at(OWN_GUARDIAN) };
    expect(await onRoleRemoved(key(), guardian, d)).toBe('ignored');
    expect(
      await onRoleRemoved(key(), { ...guardian, role: 'approver', account: at(OPS_GUARDIAN) }, d),
    ).toBe('ignored');
    expect(await d.optOuts.hasOptedOut(key(), OPTS)).toBe(false);
  });

  it('ignores a guardian removal on a network with no operations guardian', async () => {
    const d: GuardianPolicyDeps = {
      networks: () => networks(null),
      optOuts: createMemoryGuardianOptOutStore(),
    };
    const event = { network: NETWORK, role: 'guardian' as const, account: at(OPS_GUARDIAN) };
    expect(await onRoleRemoved(key(), event, d)).toBe('ignored');
    expect(await reconcileOperationsGuardian(key(), { network: NETWORK, guardians: [] }, d)).toBe(
      'absent',
    );
    expect(await d.optOuts.hasOptedOut(key(), OPTS)).toBe(false);
  });

  it('records a removal for the one tenant it happened to', async () => {
    const d = deps();
    const event = { network: NETWORK, role: 'guardian' as const, account: at(OPS_GUARDIAN) };
    await onRoleRemoved(key('principal-1'), event, d);
    expect(await d.optOuts.hasOptedOut(key('principal-1'), OPTS)).toBe(true);
    expect(await d.optOuts.hasOptedOut(key('principal-2'), OPTS)).toBe(false);
  });

  it('bounds a hanging store with a timeout', async () => {
    const hanging: GuardianOptOutStore = {
      recordOptOut: () => new Promise(() => undefined),
      hasOptedOut: () => new Promise(() => undefined),
    };
    const d: CreationDeps = { ...deps(hanging), timeoutMs: 10 };
    await expect(
      planMandateCreation({ key: key(), network: NETWORK, config: principalConfig() }, d),
    ).rejects.toThrow(PolicyStoreTimeoutError);
  });

  it('reports a failing store as a typed error with its cause', async () => {
    const cause = new Error('connection reset');
    const failing: GuardianOptOutStore = {
      recordOptOut: () => Promise.reject(cause),
      hasOptedOut: () => Promise.reject(cause),
    };
    const event = { network: NETWORK, role: 'guardian' as const, account: at(OPS_GUARDIAN) };
    const err: unknown = await onRoleRemoved(key(), event, deps(failing)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyStoreError);
    expect((err as Error).cause).toBe(cause);
  });
});
