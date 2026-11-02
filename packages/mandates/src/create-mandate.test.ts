// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the operations guardian at creation (create-mandate.ts).
 *
 * planMandateCreation(request, deps) returns the config to create and
 * whether the operations guardian is in it.
 *
 * - By default the guardian configured for the request's network is added
 *   to the principal's own guardians, once.
 * - guardian: false leaves it out. guardian: true adds it even for a
 *   logical mandate whose principal removed it before.
 * - Left unset, a logical mandate the principal took it out of stays
 *   without it, on every new chain instance.
 * - The address is read from the networks configuration at call time; with
 *   none configured, adding it throws OperationsGuardianNotConfiguredError
 *   and opting out still works.
 * - operationsGuardian states what the returned config holds.
 */

import { describe, expect, it } from 'vitest';

import { ROLE } from '@ujira/chain-adapter/testing';

import {
  NETWORK,
  NEXT_OPS_GUARDIAN,
  OPS_GUARDIAN,
  OWN_GUARDIAN,
  PRINCIPAL,
  at,
  createOnChain,
  key,
  networks,
  principalConfig,
  world,
} from '../test/world.js';
import {
  OperationsGuardianNotConfiguredError,
  createMemoryGuardianOptOutStore,
  planMandateCreation,
} from './index.js';
import type { CreationDeps } from './index.js';

function deps(
  guardian: string | null = OPS_GUARDIAN,
): CreationDeps & { setGuardian(g: string | null): void } {
  let current = networks(guardian);
  return {
    networks: () => current,
    optOuts: createMemoryGuardianOptOutStore(),
    setGuardian(g) {
      current = networks(g);
    },
  };
}

const request = (overrides: { guardian?: boolean } = {}, config = principalConfig()) => ({
  key: key(),
  network: NETWORK,
  config,
  ...overrides,
});

describe('create-mandate', () => {
  it('adds the operations guardian by default', async () => {
    const plan = await planMandateCreation(request(), deps());
    expect(plan.operationsGuardian).toBe('present');
    expect(plan.config.guardians).toEqual([at(OPS_GUARDIAN)]);

    // And the mandate the chain creates from it holds the guardian.
    const mandate = createOnChain(world(), plan.config);
    expect(mandate.config().guardians).toEqual([OPS_GUARDIAN]);
  });

  it('guardian false creates a mandate with no operations guardian', async () => {
    const plan = await planMandateCreation(request({ guardian: false }), deps());
    expect(plan.operationsGuardian).toBe('absent');
    expect(plan.config.guardians).toEqual([]);
    expect(createOnChain(world(), plan.config).config().guardians).toEqual([]);
  });

  it('guardian address read from chain config', async () => {
    const d = deps();
    expect((await planMandateCreation(request(), d)).config.guardians).toEqual([at(OPS_GUARDIAN)]);
    // A rotated address applies to the next creation with no code change.
    d.setGuardian(NEXT_OPS_GUARDIAN);
    expect((await planMandateCreation(request(), d)).config.guardians).toEqual([
      at(NEXT_OPS_GUARDIAN),
    ]);
  });

  it('keeps the principal own guardians and adds the operations guardian after them', async () => {
    const config = principalConfig({ guardians: [at(OWN_GUARDIAN)] });
    const plan = await planMandateCreation(request({}, config), deps());
    expect(plan.config.guardians).toEqual([at(OWN_GUARDIAN), at(OPS_GUARDIAN)]);
    expect(createOnChain(world(), plan.config).config().guardians).toEqual([
      OWN_GUARDIAN,
      OPS_GUARDIAN,
    ]);
  });

  it('never lists the operations guardian twice', async () => {
    const config = principalConfig({ guardians: [at(OPS_GUARDIAN)] });
    const plan = await planMandateCreation(request({}, config), deps());
    expect(plan.config.guardians).toEqual([at(OPS_GUARDIAN)]);
    expect(plan.operationsGuardian).toBe('present');
  });

  it('states present when the principal listed it while opting out', async () => {
    const config = principalConfig({ guardians: [at(OPS_GUARDIAN)] });
    const plan = await planMandateCreation(request({ guardian: false }, config), deps());
    expect(plan.operationsGuardian).toBe('present');
  });

  it('refuses to create without a configured guardian unless opted out', async () => {
    await expect(planMandateCreation(request(), deps(null))).rejects.toThrow(
      OperationsGuardianNotConfiguredError,
    );
    const plan = await planMandateCreation(request({ guardian: false }), deps(null));
    expect(plan.operationsGuardian).toBe('absent');
  });

  it('leaves out the guardian on a new instance of a mandate whose principal removed it', async () => {
    const d = deps();
    await d.optOuts.recordOptOut(key(), { signal: new AbortController().signal });
    expect((await planMandateCreation(request(), d)).operationsGuardian).toBe('absent');
    // The principal can still choose to have it back.
    expect((await planMandateCreation(request({ guardian: true }), d)).operationsGuardian).toBe(
      'present',
    );
  });

  it('applies one tenant opt out to that tenant only', async () => {
    const d = deps();
    await d.optOuts.recordOptOut(key('principal-1', 'mandate-1'), {
      signal: new AbortController().signal,
    });
    const other = { ...request(), key: key('principal-2', 'mandate-1') };
    expect((await planMandateCreation(other, d)).operationsGuardian).toBe('present');
  });

  it('does not change the request it was given', async () => {
    const config = principalConfig();
    const plan = await planMandateCreation(request({}, config), deps());
    expect(config.guardians).toEqual([]);
    expect(Object.isFrozen(plan.config.guardians)).toBe(true);
  });

  it('creates a guardian that can pause and nothing else', async () => {
    const plan = await planMandateCreation(request(), deps());
    const mandate = createOnChain(world(), plan.config);
    mandate.pause({ caller: OPS_GUARDIAN });
    expect(mandate.state().paused).toBe(true);
    expect(() => {
      mandate.resume({ caller: OPS_GUARDIAN });
    }).toThrow();
    expect(() => {
      mandate.removeRole({ caller: OPS_GUARDIAN }, ROLE.GUARDIAN, OPS_GUARDIAN);
    }).toThrow();
    mandate.resume({ caller: PRINCIPAL });
    expect(mandate.state().paused).toBe(false);
  });
});
