// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the custody guard at creation (custody.ts, create-mandate.ts).
 *
 * - planMandateCreation refuses recipient mode attested with a managed
 *   agent, with CustodyGuardError (code CUSTODY_GUARD), before any store is
 *   read. Allowlist and both are accepted with a managed agent, and every
 *   mode is accepted with the principal's own agent key.
 * - recipientModesOffered is what a creation form shows: no attested mode
 *   once the managed agent option is chosen.
 */

import { describe, expect, it } from 'vitest';

import type { MandateConfigInput } from '@ujira/chain-adapter';

import { NETWORK, createOnChain, key, networks, principalConfig, world } from '../test/world.js';
import {
  CustodyGuardError,
  allowsManagedAgent,
  assertCustodyAllowed,
  createMemoryGuardianOptOutStore,
  planMandateCreation,
  recipientModesOffered,
} from './index.js';
import type { CreationDeps, GuardianOptOutStore, RecipientMode } from './index.js';

const ATTESTER = new Uint8Array(32).fill(7);

function deps(optOuts: GuardianOptOutStore = createMemoryGuardianOptOutStore()): CreationDeps {
  return { networks: () => networks(), optOuts };
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

  it('treats a request that does not say as the principal own agent key', async () => {
    const created = await planMandateCreation(
      { key: key(), network: NETWORK, config: configIn('attested') },
      deps(),
    );
    expect(created.config.recipientMode).toBe('attested');
  });

  it('refuses before reading any store', async () => {
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
