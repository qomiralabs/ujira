// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the custody guard at creation (custody.ts, create-mandate.ts).
 *
 * - planMandateCreation refuses recipient mode attested with a managed
 *   agent, with CustodyGuardError (code CUSTODY_GUARD), before the other
 *   rules run. Allowlist and both are accepted with a managed agent, and
 *   every mode is accepted with the principal's own agent key.
 * - An agent is managed when the request says so or when the managed agent
 *   keys hold its address for this tenant. Leaving the flag out vouches for
 *   nothing, and a lookup that fails or hangs stops creation.
 * - recipientModesOffered is what a creation form shows: no attested mode
 *   once the managed agent option is chosen.
 */

import { describe, expect, it } from 'vitest';

import type { MandateConfigInput } from '@ujira/chain-adapter';

import {
  AGENT,
  NETWORK,
  at,
  createOnChain,
  key,
  networks,
  principalConfig,
  world,
} from '../test/world.js';
import {
  CustodyGuardError,
  PolicyStoreError,
  PolicyStoreTimeoutError,
  allowsManagedAgent,
  assertCustodyAllowed,
  createMemoryGuardianOptOutStore,
  createMemoryManagedAgentKeys,
  planMandateCreation,
  recipientModesOffered,
} from './index.js';
import type {
  CreationDeps,
  GuardianOptOutStore,
  ManagedAgentKeys,
  RecipientMode,
} from './index.js';

const ATTESTER = new Uint8Array(32).fill(7);

function deps(
  optOuts: GuardianOptOutStore = createMemoryGuardianOptOutStore(),
  managedAgents: ManagedAgentKeys = createMemoryManagedAgentKeys(),
): CreationDeps {
  return { networks: () => networks(), optOuts, managedAgents };
}

function configIn(mode: RecipientMode): MandateConfigInput {
  return principalConfig({ recipientMode: mode, attester: mode === 'allowlist' ? null : ATTESTER });
}

const plan = (mode: RecipientMode, managedAgent: boolean, d: CreationDeps = deps()) =>
  planMandateCreation({ key: key(), network: NETWORK, config: configIn(mode), managedAgent }, d);

describe('create-mandate.custody', () => {
  it('ATTESTED with a managed agent returns CUSTODY_GUARD', async () => {
    const err: unknown = await plan('attested', true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustodyGuardError);
    expect((err as CustodyGuardError).code).toBe('CUSTODY_GUARD');
  });

  it.each(['allowlist', 'both'] as const)(
    '%s with a managed agent is accepted and creates on chain',
    async (mode) => {
      const created = await plan(mode, true);
      expect(created.config.recipientMode).toBe(mode);
      const mandate = createOnChain(world(), created.config);
      expect(mandate.recipientMode).toBe(mode.toUpperCase());
    },
  );

  it.each(['allowlist', 'attested', 'both'] as const)(
    '%s with the principal own agent key is accepted',
    async (mode) => {
      expect((await plan(mode, false)).config.recipientMode).toBe(mode);
    },
  );

  const withoutFlag = (d: CreationDeps, mode: RecipientMode = 'attested') =>
    planMandateCreation({ key: key(), network: NETWORK, config: configIn(mode) }, d);

  it('accepts attested when no agent is a key UJIRA holds', async () => {
    expect((await withoutFlag(deps())).config.recipientMode).toBe('attested');
  });

  it('refuses a managed key named as if it were the principal own', async () => {
    const managed = createMemoryManagedAgentKeys();
    managed.add({ principalId: key().principalId, projectId: key().projectId }, at(AGENT));
    await expect(withoutFlag(deps(undefined, managed))).rejects.toThrow(CustodyGuardError);
    // And when the request says it is not managed.
    await expect(plan('attested', false, deps(undefined, managed))).rejects.toThrow(
      CustodyGuardError,
    );
    // The same key is allowed where the allowlist binds the destination.
    expect((await withoutFlag(deps(undefined, managed), 'both')).config.recipientMode).toBe('both');
  });

  it('does not count a key another tenant holds', async () => {
    const managed = createMemoryManagedAgentKeys();
    managed.add(
      { principalId: key('principal-2').principalId, projectId: key().projectId },
      at(AGENT),
    );
    expect((await withoutFlag(deps(undefined, managed))).config.recipientMode).toBe('attested');
  });

  it('stops creation when the lookup fails or hangs', async () => {
    const failing: ManagedAgentKeys = { isManaged: () => Promise.reject(new Error('db down')) };
    await expect(withoutFlag(deps(undefined, failing))).rejects.toThrow(PolicyStoreError);
    const hanging: ManagedAgentKeys = { isManaged: () => new Promise(() => undefined) };
    await expect(withoutFlag({ ...deps(undefined, hanging), timeoutMs: 10 })).rejects.toThrow(
      PolicyStoreTimeoutError,
    );
  });

  it('skips the lookup for a mode that allows a managed agent', async () => {
    const failing: ManagedAgentKeys = { isManaged: () => Promise.reject(new Error('db down')) };
    expect((await withoutFlag(deps(undefined, failing), 'allowlist')).operationsGuardian).toBe(
      'present',
    );
  });

  it('refuses before the other rules read their stores', async () => {
    const untouchable: GuardianOptOutStore = {
      recordOptOut: () => Promise.reject(new Error('must not be called')),
      hasOptedOut: () => Promise.reject(new Error('must not be called')),
    };
    await expect(plan('attested', true, deps(untouchable))).rejects.toThrow(CustodyGuardError);
  });

  it('offers no attested only mode once a managed agent is chosen', () => {
    expect(recipientModesOffered(true)).toEqual(['allowlist', 'both']);
    expect(recipientModesOffered(false)).toEqual(['allowlist', 'attested', 'both']);
    for (const mode of recipientModesOffered(true)) expect(allowsManagedAgent(mode)).toBe(true);
    expect(() => {
      assertCustodyAllowed('attested', false);
    }).not.toThrow();
  });
});
