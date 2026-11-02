// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the principal key rule (principal-key.ts, create-mandate.ts).
 *
 * - The logical budget is the sum of total_budget over every live instance
 *   the principal holds, across projects, in USD at par with nothing rounded.
 * - At or below 50,000 USD anything may be created; a single key principal
 *   gets a warning at any budget.
 * - Above it, creation and any budget increase throw PrincipalKeyRiskError
 *   (code PRINCIPAL_KEY_RISK) unless every instance qualifies: a multisig
 *   principal needing at least two signatures, or a recovery set with a
 *   threshold of at least two, read from the mandate's config().
 * - Unverified contract wallets never qualify on their own.
 * - Lowering a budget is always allowed, even above the line.
 * - Gates read the chain fresh. Only the dashboard warning may use the cache,
 *   which is keyed by principal and expires.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ChainAddress, MandateConfigInput, Uuid } from '@ujira/chain-adapter';
import { tokenAmount } from '@ujira/core';
import type { TokenAmount } from '@ujira/core';

import {
  NETWORK,
  PRINCIPAL,
  account,
  at,
  createOnChain,
  instanceOf,
  key,
  networks,
  principalConfig,
  usdc,
  world,
} from '../test/world.js';
import {
  PRINCIPAL_KEY_LIMIT,
  PolicyStoreTimeoutError,
  PrincipalKeyRiskError,
  assertMayChangeBudget,
  assertMayCreate,
  cachePrincipalKeyReader,
  checkPrincipalKeyRule,
  createMemoryGuardianOptOutStore,
  createMemoryManagedAgentKeys,
  createMemoryPrincipalInstances,
  createMemoryPrincipalKeyReader,
  isAboveLimit,
  logicalBudgetUsd,
  planMandateCreation,
  principalKeyWarning,
} from './index.js';
import type { CreationDeps, InstanceView, PrincipalKeyDeps } from './index.js';

const PRINCIPAL_ID = key().principalId;
const OPTS = { signal: new AbortController().signal, fresh: false };
const OVER_THE_LINE = tokenAmount('500000000010', 'USDC', 'stellar'); // 50,000.000001 USD
const RECOVERY = [at(account('recovery-1')), at(account('recovery-2'))];

function instance(
  instanceId: string,
  totalBudget: TokenAmount,
  overrides: Partial<InstanceView> = {},
): InstanceView {
  return {
    instanceId,
    projectId: key().projectId,
    principal: at(PRINCIPAL),
    totalBudget,
    recovery: [],
    recoveryThreshold: 0,
    ...overrides,
  };
}

function gate() {
  const instances = createMemoryPrincipalInstances();
  const signing = createMemoryPrincipalKeyReader();
  const deps: PrincipalKeyDeps = { instances, signing };
  return { instances, signing, deps };
}

function creationDeps(principalKeys: PrincipalKeyDeps = gate().deps): CreationDeps {
  return {
    networks: () => networks(),
    optOuts: createMemoryGuardianOptOutStore(),
    managedAgents: createMemoryManagedAgentKeys(),
    principalKeys,
  };
}

function withBudget(totalBudget: TokenAmount, overrides: Partial<MandateConfigInput> = {}) {
  const base = principalConfig(overrides);
  return { ...base, limits: { ...base.limits, totalBudget } };
}

const create = (config: ReturnType<typeof principalConfig>, d: CreationDeps = creationDeps()) =>
  planMandateCreation({ key: key(), network: NETWORK, config }, d);

describe('principal-gate', () => {
  it('50000 USD single key creates with warning', async () => {
    const plan = await create(withBudget(usdc(50_000n)));
    expect(plan.warnings).toEqual(['single_key_principal']);
    expect(createOnChain(world(), plan.config).config().limits.totalBudget).toBe(
      usdc(50_000n).amount,
    );
  });

  it('50000.000001 USD single key returns PRINCIPAL_KEY_RISK', async () => {
    const err: unknown = await create(withBudget(OVER_THE_LINE)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrincipalKeyRiskError);
    const risk = err as PrincipalKeyRiskError;
    expect(risk.code).toBe('PRINCIPAL_KEY_RISK');
    expect(risk.fixes).toEqual(['add_recovery_set', 'use_multisig_principal', 'lower_budget']);
    expect(risk.unqualified).toHaveLength(1);
  });

  it('raising a compliant 40000 USD mandate to 60000 USD with a single key is refused', async () => {
    const { instances, deps } = gate();
    instances.put(PRINCIPAL_ID, instance('a', usdc(40_000n)));
    await expect(
      assertMayChangeBudget(PRINCIPAL_ID, instance('a', usdc(60_000n)), deps),
    ).rejects.toThrow(PrincipalKeyRiskError);
  });

  it('allows raising a budget that stays at or under the line', async () => {
    const { instances, deps } = gate();
    instances.put(PRINCIPAL_ID, instance('a', usdc(40_000n)));
    const verdict = await assertMayChangeBudget(PRINCIPAL_ID, instance('a', usdc(50_000n)), deps);
    expect(verdict.allowed).toBe(true);
    expect(verdict.warnings).toEqual(['single_key_principal']);
  });

  it('allows lowering a budget that is still above the line', async () => {
    const { instances, deps } = gate();
    instances.put(PRINCIPAL_ID, instance('a', usdc(90_000n)));
    const verdict = await assertMayChangeBudget(PRINCIPAL_ID, instance('a', usdc(70_000n)), deps);
    expect(verdict.allowed).toBe(false);
    expect(verdict.aboveLimit).toBe(true);
  });

  it('treats a change to an instance it does not know as an increase', async () => {
    await expect(
      assertMayChangeBudget(PRINCIPAL_ID, instance('new', usdc(60_000n)), gate().deps),
    ).rejects.toThrow(PrincipalKeyRiskError);
  });

  it('recovery threshold 2 qualifies', async () => {
    const config = withBudget(usdc(60_000n), { recovery: RECOVERY, recoveryThreshold: 2 });
    const plan = await create(config);
    expect(plan.warnings).toEqual(['single_key_principal']);

    // The same answer from what the chain holds.
    const onChain = instanceOf(createOnChain(world(), plan.config), 'a');
    expect(onChain.recoveryThreshold).toBe(2);
    await expect(assertMayCreate(PRINCIPAL_ID, onChain, gate().deps)).resolves.toMatchObject({
      allowed: true,
      aboveLimit: true,
    });
  });

  it('recovery threshold 1 does not', async () => {
    const config = withBudget(usdc(60_000n), { recovery: RECOVERY, recoveryThreshold: 1 });
    await expect(create(config)).rejects.toThrow(PrincipalKeyRiskError);
  });

  it('an empty recovery set does not qualify, whatever the threshold says', async () => {
    const proposed = instance('a', usdc(60_000n), { recoveryThreshold: 2 });
    await expect(assertMayCreate(PRINCIPAL_ID, proposed, gate().deps)).rejects.toThrow(
      PrincipalKeyRiskError,
    );
  });

  it('two mandates of 30000 each are above the line', async () => {
    const { instances, deps } = gate();
    instances.put(PRINCIPAL_ID, instance('first', usdc(30_000n)));
    await expect(create(withBudget(usdc(30_000n)), creationDeps(deps))).rejects.toThrow(
      PrincipalKeyRiskError,
    );
  });

  it('counts other projects of the same principal', async () => {
    const { instances, deps } = gate();
    instances.put(PRINCIPAL_ID, instance('project-2-mandate', usdc(30_000n)));
    const request = {
      key: { ...key(), projectId: 'project-3' as Uuid },
      network: NETWORK,
      config: withBudget(usdc(30_000n)),
    };
    await expect(planMandateCreation(request, creationDeps(deps))).rejects.toThrow(
      PrincipalKeyRiskError,
    );
  });

  it('never counts another principal', async () => {
    const { instances, deps } = gate();
    instances.put('principal-2' as Uuid, instance('theirs', usdc(49_000n)));
    await expect(create(withBudget(usdc(30_000n)), creationDeps(deps))).resolves.toMatchObject({
      warnings: ['single_key_principal'],
    });
  });

  it('counts an instance being replaced once', async () => {
    const { instances, deps } = gate();
    instances.put(PRINCIPAL_ID, instance('a', usdc(30_000n)));
    const verdict = await checkPrincipalKeyRule(PRINCIPAL_ID, instance('a', usdc(40_000n)), deps);
    expect(verdict.aboveLimit).toBe(false);
    expect(verdict.logicalBudget.amount).toBe(usdc(40_000n).amount);
  });

  it('requires every instance to qualify', async () => {
    const { instances, signing, deps } = gate();
    const multisig = at(account('multisig'));
    signing.set(multisig, { kind: 'multisig', minSignatures: 2 });
    instances.put(PRINCIPAL_ID, instance('weak', usdc(40_000n)));
    const proposed = instance('strong', usdc(40_000n), { principal: multisig });
    const err: unknown = await assertMayCreate(PRINCIPAL_ID, proposed, deps).catch(
      (e: unknown) => e,
    );
    expect((err as PrincipalKeyRiskError).unqualified).toEqual(['weak']);
  });

  it.each<[string, { kind: 'multisig'; minSignatures: number } | { kind: 'unverified' }, boolean]>([
    ['a multisig needing two signatures', { kind: 'multisig', minSignatures: 2 }, true],
    ['a multisig needing three signatures', { kind: 'multisig', minSignatures: 3 }, true],
    ['a multisig one key can authorize', { kind: 'multisig', minSignatures: 1 }, false],
    ['an unknown contract wallet', { kind: 'unverified' }, false],
  ])('above the line, %s', async (_label, kind, allowed) => {
    const { signing, deps } = gate();
    signing.set(at(PRINCIPAL), kind);
    const verdict = await checkPrincipalKeyRule(PRINCIPAL_ID, instance('a', usdc(60_000n)), deps);
    expect(verdict.allowed).toBe(allowed);
  });

  it('warns only about a principal one key controls or that cannot be verified', async () => {
    const { signing, deps } = gate();
    const principal: ChainAddress = at(PRINCIPAL);
    expect(await principalKeyWarning(PRINCIPAL_ID, principal, deps)).toBe('single_key_principal');
    signing.set(principal, { kind: 'multisig', minSignatures: 1 });
    expect(await principalKeyWarning(PRINCIPAL_ID, principal, deps)).toBe('single_key_principal');
    signing.set(principal, { kind: 'unverified' });
    expect(await principalKeyWarning(PRINCIPAL_ID, principal, deps)).toBe('unverified_principal');
    signing.set(principal, { kind: 'multisig', minSignatures: 2 });
    expect(await principalKeyWarning(PRINCIPAL_ID, principal, deps)).toBeNull();
  });

  it('reads one principal once per check, always fresh', async () => {
    const { instances, signing, deps } = gate();
    const read = vi.spyOn(signing, 'read');
    instances.put(PRINCIPAL_ID, instance('a', usdc(1n)));
    await checkPrincipalKeyRule(PRINCIPAL_ID, instance('b', usdc(1n)), deps);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[2].fresh).toBe(true);
  });

  it('bounds the chain read with a timeout', async () => {
    const { instances } = gate();
    const deps: PrincipalKeyDeps = {
      instances,
      signing: { read: () => new Promise(() => undefined) },
      timeoutMs: 10,
    };
    await expect(
      checkPrincipalKeyRule(PRINCIPAL_ID, instance('a', usdc(1n)), deps),
    ).rejects.toThrow(PolicyStoreTimeoutError);
  });

  it('refuses creation when the chain cannot be read, rather than letting it through', async () => {
    const deps: PrincipalKeyDeps = {
      instances: createMemoryPrincipalInstances(),
      signing: { read: () => Promise.reject(new Error('rpc down')) },
    };
    await expect(create(withBudget(usdc(1n)), creationDeps(deps))).rejects.toThrow();
  });
});

describe('logical budget', () => {
  it('sums at par with nothing rounded', () => {
    const total = logicalBudgetUsd([usdc(1n), tokenAmount('1', 'USDC', 'stellar')]);
    expect(total.currency).toBe('USD');
    expect(total.scale).toBe(7);
    expect(total.amount).toBe(10_000_001n);
  });

  it('is zero with nothing held', () => {
    expect(logicalBudgetUsd([]).amount).toBe(0n);
    expect(isAboveLimit(logicalBudgetUsd([]))).toBe(false);
  });

  it('draws the line exactly at 50000 USD', () => {
    expect(PRINCIPAL_KEY_LIMIT.amount).toBe(5_000_000n);
    expect(isAboveLimit(logicalBudgetUsd([usdc(50_000n)]))).toBe(false);
    expect(isAboveLimit(logicalBudgetUsd([OVER_THE_LINE]))).toBe(true);
    // One raw unit is enough.
    expect(isAboveLimit(logicalBudgetUsd([tokenAmount('500000000001', 'USDC', 'stellar')]))).toBe(
      true,
    );
  });
});

describe('cachePrincipalKeyReader', () => {
  function cached() {
    const inner = createMemoryPrincipalKeyReader();
    const read = vi.spyOn(inner, 'read');
    let time = 1_000;
    const reader = cachePrincipalKeyReader(inner, { ttlMs: 100, now: () => time });
    return {
      inner,
      read,
      reader,
      advance: (ms: number) => {
        time += ms;
      },
    };
  }

  it('answers from the cache until the entry expires', async () => {
    const { read, reader, advance } = cached();
    await reader.read(PRINCIPAL_ID, at(PRINCIPAL), OPTS);
    advance(99);
    await reader.read(PRINCIPAL_ID, at(PRINCIPAL), OPTS);
    expect(read).toHaveBeenCalledTimes(1);
    advance(1);
    await reader.read(PRINCIPAL_ID, at(PRINCIPAL), OPTS);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('skips and refreshes the cache on a fresh read', async () => {
    const { inner, reader } = cached();
    await reader.read(PRINCIPAL_ID, at(PRINCIPAL), OPTS);
    inner.set(at(PRINCIPAL), { kind: 'multisig', minSignatures: 2 });
    expect(await reader.read(PRINCIPAL_ID, at(PRINCIPAL), { ...OPTS, fresh: true })).toEqual({
      kind: 'multisig',
      minSignatures: 2,
    });
    expect(await reader.read(PRINCIPAL_ID, at(PRINCIPAL), OPTS)).toEqual({
      kind: 'multisig',
      minSignatures: 2,
    });
  });

  it('keeps entries per principal, so a tenant never reads another tenant entry', async () => {
    const { read, reader } = cached();
    await reader.read(PRINCIPAL_ID, at(PRINCIPAL), OPTS);
    await reader.read('principal-2' as Uuid, at(PRINCIPAL), OPTS);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('caches nothing when the read fails', async () => {
    const failing = cachePrincipalKeyReader({ read: () => Promise.reject(new Error('rpc down')) });
    await expect(failing.read(PRINCIPAL_ID, at(PRINCIPAL), OPTS)).rejects.toThrow('rpc down');
  });
});
