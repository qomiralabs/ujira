// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for serving only mandates that keep the principal key rule
 * (compliance.ts), driven by real events from the in-memory mandate.
 *
 * - limits_updated, role_added, role_removed, recovery_threshold_set and
 *   principal_transferred re-run the rule over everything the principal
 *   holds; other events change nothing.
 * - A failing instance is marked noncompliant with its reason and time, and
 *   the principal gets one notice per change with the exact fixes.
 * - When it complies again the mark clears, one notice goes out and parked
 *   jobs resume. A replayed event changes nothing and notifies nobody.
 * - A chain read that fails throws and changes nothing: no mark set, none
 *   cleared.
 */

import { describe, expect, it } from 'vitest';

import type { Uuid } from '@ujira/chain-adapter';
import { ROLE } from '@ujira/chain-adapter/testing';
import type { EngineEvent, MandateEngine } from '@ujira/chain-adapter/testing';

import {
  PRINCIPAL,
  account,
  at,
  createOnChain,
  instanceOf,
  key,
  principalConfig,
  usdc,
  world,
} from '../test/world.js';
import type { World } from '../test/world.js';
import {
  PRINCIPAL_KEY_FIXES,
  PolicyStoreTimeoutError,
  createMemoryComplianceStore,
  createMemoryPrincipalInstances,
  createMemoryPrincipalKeyReader,
  guardSubmission,
  onMandateEvent,
  onMandateRetired,
  recheckPrincipal,
  servableInstances,
} from './index.js';
import type { ComplianceDeps, InstanceKey } from './index.js';

const PRINCIPAL_ID = key().principalId;
const RECOVERY_1 = account('recovery-1');
const RECOVERY_2 = account('recovery-2');
const WHEN = new Date('2026-11-02T00:00:00Z');

function setup() {
  const w = world();
  const instances = createMemoryPrincipalInstances();
  const signing = createMemoryPrincipalKeyReader();
  const compliance = createMemoryComplianceStore();
  const deps: ComplianceDeps = { instances, signing, compliance, now: () => WHEN };
  return { w, instances, signing, compliance, deps };
}

const keyOf = (instanceId: string): InstanceKey => ({
  principalId: PRINCIPAL_ID,
  projectId: key().projectId,
  instanceId,
});

function mandateOf(w: World, dollars: bigint, salt = 'salt'): MandateEngine {
  const base = principalConfig();
  return createOnChain(
    w,
    { ...base, limits: { ...base.limits, totalBudget: usdc(dollars) } },
    salt,
  );
}

function setBudget(mandate: MandateEngine, dollars: bigint): void {
  mandate.updateLimits(
    { caller: PRINCIPAL },
    { ...mandate.config().limits, totalBudget: usdc(dollars).amount },
  );
}

function addRecoverySet(mandate: MandateEngine): void {
  mandate.addRole({ caller: PRINCIPAL }, ROLE.RECOVERY, RECOVERY_1);
  mandate.addRole({ caller: PRINCIPAL }, ROLE.RECOVERY, RECOVERY_2);
  mandate.setRecoveryThreshold({ caller: PRINCIPAL }, 2);
}

function lastEvent(w: World): EngineEvent {
  const event = w.ledger.events.at(-1);
  if (event === undefined) throw new Error('expected an event');
  return event;
}

describe('compliance', () => {
  it('limits_updated above 50000 USD with a single key marks noncompliant', async () => {
    const { w, instances, compliance, deps } = setup();
    const mandate = mandateOf(w, 40_000n);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    expect(await recheckPrincipal(PRINCIPAL_ID, deps)).toEqual([]);

    // Straight to the contract with the principal's key, around the gate.
    setBudget(mandate, 60_000n);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    const event = lastEvent(w);
    expect(event.name).toBe('limits_updated');
    const notices = await onMandateEvent(PRINCIPAL_ID, event.name, deps);

    expect(notices).toEqual([
      { key: keyOf('a'), to: 'noncompliant', at: WHEN, fixes: PRINCIPAL_KEY_FIXES },
    ]);
    expect(await compliance.read(keyOf('a'), { signal: new AbortController().signal })).toEqual({
      reason: 'principal_key_risk',
      since: WHEN,
    });
  });

  it('adding a recovery set with threshold 2 clears the mark and resumes parked jobs', async () => {
    const { w, instances, compliance, deps } = setup();
    const mandate = mandateOf(w, 60_000n);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    await recheckPrincipal(PRINCIPAL_ID, deps);
    expect(await guardSubmission(keyOf('a'), 'job-1', deps)).toEqual({
      action: 'park',
      status: 'blocked_by_policy',
    });
    expect(await guardSubmission(keyOf('a'), 'job-2', deps)).toMatchObject({ action: 'park' });

    // Two members at the threshold of 1 they start with is not enough yet.
    mandate.addRole({ caller: PRINCIPAL }, ROLE.RECOVERY, RECOVERY_1);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    expect(await onMandateEvent(PRINCIPAL_ID, 'role_added', deps)).toEqual([]);
    mandate.addRole({ caller: PRINCIPAL }, ROLE.RECOVERY, RECOVERY_2);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    expect(await onMandateEvent(PRINCIPAL_ID, 'role_added', deps)).toEqual([]);
    expect(compliance.resumed).toEqual([]);

    mandate.setRecoveryThreshold({ caller: PRINCIPAL }, 2);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    const event = lastEvent(w);
    expect(event.name).toBe('recovery_threshold_set');
    const notices = await onMandateEvent(PRINCIPAL_ID, event.name, deps);

    expect(notices).toEqual([{ key: keyOf('a'), to: 'compliant', at: WHEN, fixes: [] }]);
    expect(compliance.resumed).toEqual(['job-1', 'job-2']);
    expect(compliance.parked(keyOf('a'))).toEqual([]);
    expect(await guardSubmission(keyOf('a'), 'job-3', deps)).toEqual({ action: 'submit' });
  });

  it('one notification per transition', async () => {
    const { w, instances, compliance, deps } = setup();
    const mandate = mandateOf(w, 60_000n);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));

    await onMandateEvent(PRINCIPAL_ID, 'limits_updated', deps);
    // The indexer replays, and other watched events arrive with no change.
    await onMandateEvent(PRINCIPAL_ID, 'limits_updated', deps);
    await onMandateEvent(PRINCIPAL_ID, 'role_removed', deps);
    expect(compliance.notices.map((n) => n.to)).toEqual(['noncompliant']);

    setBudget(mandate, 10_000n);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    await onMandateEvent(PRINCIPAL_ID, 'limits_updated', deps);
    await onMandateEvent(PRINCIPAL_ID, 'limits_updated', deps);
    expect(compliance.notices.map((n) => n.to)).toEqual(['noncompliant', 'compliant']);
  });

  it('marks every instance a change puts out of compliance, not just its own', async () => {
    const { w, instances, compliance, deps } = setup();
    const first = mandateOf(w, 30_000n, 'first');
    const second = mandateOf(w, 15_000n, 'second');
    instances.put(PRINCIPAL_ID, instanceOf(first, 'first'));
    instances.put(PRINCIPAL_ID, instanceOf(second, 'second'));
    expect(await recheckPrincipal(PRINCIPAL_ID, deps)).toEqual([]);

    setBudget(second, 25_000n);
    instances.put(PRINCIPAL_ID, instanceOf(second, 'second'));
    await onMandateEvent(PRINCIPAL_ID, 'limits_updated', deps);
    expect(compliance.notices.map((n) => n.key.instanceId).sort()).toEqual(['first', 'second']);
  });

  it('leaves a qualifying instance serving while another is marked', async () => {
    const { w, instances, compliance, deps } = setup();
    const weak = mandateOf(w, 40_000n, 'weak');
    const strong = mandateOf(w, 40_000n, 'strong');
    addRecoverySet(strong);
    instances.put(PRINCIPAL_ID, instanceOf(weak, 'weak'));
    instances.put(PRINCIPAL_ID, instanceOf(strong, 'strong'));
    await recheckPrincipal(PRINCIPAL_ID, deps);
    expect(compliance.notices.map((n) => n.key.instanceId)).toEqual(['weak']);
  });

  it('clears the mark when the principal moves to a multisig', async () => {
    const { w, instances, signing, compliance, deps } = setup();
    const mandate = mandateOf(w, 60_000n);
    const multisig = account('multisig');
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    await recheckPrincipal(PRINCIPAL_ID, deps);

    mandate.proposePrincipal({ caller: PRINCIPAL }, multisig);
    mandate.acceptPrincipal({ caller: multisig });
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    signing.set(at(multisig), { kind: 'multisig', minSignatures: 2 });
    const event = lastEvent(w);
    expect(event.name).toBe('principal_transferred');
    await onMandateEvent(PRINCIPAL_ID, event.name, deps);
    expect(compliance.notices.map((n) => n.to)).toEqual(['noncompliant', 'compliant']);
  });

  it('marks again when a qualifying recovery threshold is lowered', async () => {
    const { w, instances, compliance, deps } = setup();
    const mandate = mandateOf(w, 60_000n);
    addRecoverySet(mandate);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    await recheckPrincipal(PRINCIPAL_ID, deps);
    expect(compliance.notices).toEqual([]);

    mandate.setRecoveryThreshold({ caller: PRINCIPAL }, 1);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    await onMandateEvent(PRINCIPAL_ID, 'recovery_threshold_set', deps);
    expect(compliance.notices.map((n) => n.to)).toEqual(['noncompliant']);
  });

  it('ignores events that cannot change the answer', async () => {
    const { w, instances, compliance, deps } = setup();
    instances.put(PRINCIPAL_ID, instanceOf(mandateOf(w, 60_000n), 'a'));
    expect(await onMandateEvent(PRINCIPAL_ID, 'payout_requested', deps)).toEqual([]);
    expect(compliance.notices).toEqual([]);
  });

  it('changes nothing when the chain cannot be read', async () => {
    const { w, instances, compliance, deps } = setup();
    const mandate = mandateOf(w, 60_000n);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    await recheckPrincipal(PRINCIPAL_ID, deps);

    setBudget(mandate, 10_000n);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    const down: ComplianceDeps = {
      ...deps,
      signing: { read: () => new Promise(() => undefined) },
      timeoutMs: 10,
    };
    await expect(onMandateEvent(PRINCIPAL_ID, 'limits_updated', down)).rejects.toThrow(
      PolicyStoreTimeoutError,
    );
    // Still marked: an outage never restores service.
    expect(await servableInstances([{ key: keyOf('a') }], deps)).toEqual([]);
    expect(compliance.notices).toHaveLength(1);
  });

  it('keeps one tenant marks away from another tenant', async () => {
    const { w, instances, deps } = setup();
    instances.put(PRINCIPAL_ID, instanceOf(mandateOf(w, 60_000n), 'a'));
    await recheckPrincipal(PRINCIPAL_ID, deps);
    const other: InstanceKey = { ...keyOf('a'), principalId: 'principal-2' as Uuid };
    const otherProject: InstanceKey = { ...keyOf('a'), projectId: 'project-9' as Uuid };
    expect(await servableInstances([{ key: other }, { key: otherProject }], deps)).toHaveLength(2);
    expect(await guardSubmission(other, 'job-1', deps)).toEqual({ action: 'submit' });
  });

  it('sends nothing to the chain: the contract and its agents are unaffected', async () => {
    const { w, instances, deps } = setup();
    const mandate = mandateOf(w, 60_000n);
    instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    const before = w.ledger.events.length;
    await recheckPrincipal(PRINCIPAL_ID, deps);
    expect(w.ledger.events).toHaveLength(before);
    expect(mandate.state().paused).toBe(false);
  });
});

describe('a retired mandate', () => {
  const OPTS = { signal: new AbortController().signal };

  async function markedWithJobs() {
    const s = setup();
    const mandate = mandateOf(s.w, 60_000n);
    s.instances.put(PRINCIPAL_ID, instanceOf(mandate, 'a'));
    await recheckPrincipal(PRINCIPAL_ID, s.deps);
    await guardSubmission(keyOf('a'), 'job-1', s.deps);
    await guardSubmission(keyOf('a'), 'job-2', s.deps);
    return s;
  }

  it('revoking a marked mandate closes out its parked jobs', async () => {
    const { instances, compliance, deps } = await markedWithJobs();
    instances.remove(PRINCIPAL_ID, 'a');

    const outcome = await onMandateRetired(keyOf('a'), 'mandate_revoked', deps);

    expect(outcome.closedJobs).toEqual(['job-1', 'job-2']);
    expect(compliance.closed).toEqual([
      { jobId: 'job-1', reason: 'mandate_revoked' },
      { jobId: 'job-2', reason: 'mandate_revoked' },
    ]);
    expect(compliance.parked(keyOf('a'))).toEqual([]);
    expect(compliance.resumed).toEqual([]);
    expect(await compliance.read(keyOf('a'), OPTS)).toBeNull();
  });

  it('no compliant notice is sent for a revoked mandate', async () => {
    const { instances, compliance, deps } = await markedWithJobs();
    instances.remove(PRINCIPAL_ID, 'a');

    const outcome = await onMandateRetired(keyOf('a'), 'mandate_revoked', deps);

    expect(outcome.notices).toEqual([]);
    expect(compliance.notices.map((n) => [n.key.instanceId, n.to])).toEqual([
      ['a', 'noncompliant'],
    ]);
  });

  it('revoking one mandate can clear another mark when the total falls under the line', async () => {
    const { w, instances, compliance, deps } = setup();
    const first = mandateOf(w, 30_000n, 'first');
    const second = mandateOf(w, 30_000n, 'second');
    instances.put(PRINCIPAL_ID, instanceOf(first, 'first'));
    instances.put(PRINCIPAL_ID, instanceOf(second, 'second'));
    await recheckPrincipal(PRINCIPAL_ID, deps);
    expect(await compliance.read(keyOf('second'), OPTS)).not.toBeNull();
    await guardSubmission(keyOf('second'), 'job-9', deps);

    instances.remove(PRINCIPAL_ID, 'first');
    const outcome = await onMandateRetired(keyOf('first'), 'mandate_revoked', deps);

    expect(outcome.notices).toEqual([
      { key: keyOf('second'), to: 'compliant', at: WHEN, fixes: [] },
    ]);
    expect(await compliance.read(keyOf('second'), OPTS)).toBeNull();
    expect(compliance.resumed).toEqual(['job-9']);
  });

  it('expiry behaves the same way', async () => {
    const { instances, compliance, deps } = await markedWithJobs();
    instances.remove(PRINCIPAL_ID, 'a');

    const outcome = await onMandateRetired(keyOf('a'), 'mandate_expired', deps);

    expect(outcome).toEqual({ closedJobs: ['job-1', 'job-2'], notices: [] });
    expect(compliance.closed.map((c) => c.reason)).toEqual(['mandate_expired', 'mandate_expired']);
  });

  it('closes nothing twice when the event is replayed', async () => {
    const { instances, compliance, deps } = await markedWithJobs();
    instances.remove(PRINCIPAL_ID, 'a');
    await onMandateRetired(keyOf('a'), 'mandate_revoked', deps);
    expect(await onMandateRetired(keyOf('a'), 'mandate_revoked', deps)).toEqual({
      closedJobs: [],
      notices: [],
    });
    expect(compliance.closed).toHaveLength(2);
  });

  it('does not park a job that arrives after the mandate retired', async () => {
    const { instances, deps } = await markedWithJobs();
    instances.remove(PRINCIPAL_ID, 'a');
    await onMandateRetired(keyOf('a'), 'mandate_revoked', deps);
    expect(await guardSubmission(keyOf('a'), 'job-3', deps)).toEqual({ action: 'submit' });
  });

  it('changes nothing when the recheck cannot read the chain, and can be run again', async () => {
    const { instances, compliance, deps } = await markedWithJobs();
    instances.remove(PRINCIPAL_ID, 'a');
    const down = new Error('rpc down');
    const failing = {
      ...deps,
      instances: { list: () => Promise.reject(down) },
    };
    await expect(onMandateRetired(keyOf('a'), 'mandate_revoked', failing)).rejects.toMatchObject({
      code: 'POLICY_STORE_FAILED',
      cause: down,
    });
    // The close out is kept, so the retry only has the recheck left to do.
    expect(compliance.closed).toHaveLength(2);
    expect(await onMandateRetired(keyOf('a'), 'mandate_revoked', deps)).toEqual({
      closedJobs: [],
      notices: [],
    });
  });
});
