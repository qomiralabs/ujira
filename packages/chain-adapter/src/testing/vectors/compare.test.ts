// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The comparator and the invariants must fail on every kind of difference,
// or a passing vector run proves nothing. Each case starts from a real
// trace the engine wrote for a shared vector, or from the trace a perfect
// chain would write, and changes one thing.

import { describe, expect, it } from 'vitest';

import { canon, canonOrRaw, labelBytes } from './canon.js';
import { compareVector, describeMismatch, echoTrace } from './compare.js';
import { firstDifference } from './diff.js';
import { Checker, InvariantViolation } from './invariants.js';
import { amountOf, at, equal, show } from './json.js';
import type { Json, JsonObject } from './json.js';
import { loadVectors } from './load.js';
import type { LoadedVector } from './format.js';
import { runVector } from './world.js';

const all = loadVectors();

function vector(id: string): LoadedVector {
  const v = all.find((x) => x.parsed.id === id);
  if (v === undefined) throw new Error(`no vector ${id}`);
  return v;
}

function traceOf(id: string): JsonObject {
  return structuredClone(runVector(vector(id)).trace);
}

function stepAt(trace: JsonObject, n: number): JsonObject {
  const steps = trace['steps'];
  const step = Array.isArray(steps) ? steps[n - 1] : undefined;
  if (step === undefined || step === null || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error(`no step ${String(n)}`);
  }
  return step;
}

function diff(id: string, change: (trace: JsonObject) => void): string {
  const trace = traceOf(id);
  change(trace);
  const m = compareVector(vector(id).raw, trace, 'stellar');
  return m === undefined ? 'passed' : `${m.field}: ${m.detail}`;
}

const EXAMPLE = 'pause_blocks_requests_until_resume';
const FUNDING = 'events_funding_is_not_a_mandate_call';
const DAILY = 'daily_cap_exact_per_recipient';
const RECOVERY = 'recovery_revoke_at_threshold_freezes_for_the_principal';
const REVOKE = 'revoke_with_principal_without_trustline';

describe('the comparator', () => {
  it('passes the engine trace and the echo of the vector', () => {
    for (const id of [EXAMPLE, FUNDING, DAILY]) {
      expect(diff(id, () => undefined)).toBe('passed');
      expect(compareVector(vector(id).raw, echoTrace(vector(id).raw, 'stellar'), 'stellar')).toBe(
        undefined,
      );
    }
  });

  it('names the vector, the step and the field', () => {
    const trace = traceOf(EXAMPLE);
    stepAt(trace, 1)['result'] = { error: 'UNAUTHORIZED' };
    const m = compareVector(vector(EXAMPLE).raw, trace, 'stellar');
    expect(m === undefined ? '' : describeMismatch(m)).toBe(
      `vector ${EXAMPLE}, step 1 (pause): result: expected the call to succeed, got {"error":"UNAUTHORIZED"}`,
    );
    const whole = compareVector(vector(EXAMPLE).raw, { ...trace, id: 'other' }, 'stellar');
    expect(whole === undefined ? '' : describeMismatch(whole)).toBe(
      `vector ${EXAMPLE}: id: the trace is for "other"`,
    );
  });

  it('fails a run that did not run, stopped early or ran too far', () => {
    expect(diff(EXAMPLE, (t) => (t['status'] = 'skipped'))).toBe(
      'status: the vector was skipped: no reason given',
    );
    expect(
      diff(EXAMPLE, (t) => {
        t['status'] = 'aborted';
        t['reason'] = 'boom';
      }),
    ).toBe('status: the run was aborted: boom');
    expect(
      diff(EXAMPLE, (t) => {
        t['status'] = 'aborted';
        t['steps'] = [];
      }),
    ).toBe('step: the run stopped before this step: no reason given');
    expect(diff(EXAMPLE, (t) => (t['steps'] = []))).toBe(
      'step: the trace has no record of this step',
    );
    expect(
      diff(EXAMPLE, (t) => {
        const steps = t['steps'];
        if (Array.isArray(steps)) steps.push(stepAt(t, 1));
      }),
    ).toBe('steps: the trace has 7 steps, the vector 6');
    expect(diff(EXAMPLE, (t) => (t['setup_state'] = { payouts: { nolabel: null } }))).toMatch(
      /^setup_state: /,
    );
  });

  it('fails a step of the wrong kind, index, function, caller or shape', () => {
    expect(diff(EXAMPLE, (t) => (stepAt(t, 2)['step'] = 'set_time'))).toBe(
      'step: expected a "advance_time" step, got "set_time"',
    );
    expect(diff(EXAMPLE, (t) => (stepAt(t, 2)['index'] = 9))).toBe('index: expected 2, got 9');
    expect(diff(EXAMPLE, (t) => (stepAt(t, 1)['fn'] = 'resume'))).toBe(
      'fn: expected "pause", got "resume"',
    );
    expect(diff(EXAMPLE, (t) => (stepAt(t, 1)['caller'] = 'eve'))).toBe(
      'caller: expected "guardian", got "eve"',
    );
    expect(diff(EXAMPLE, (t) => (stepAt(t, 1)['decode_errors'] = ['bad']))).toBe(
      "decode: the contract's answer does not match the interface: bad",
    );
    expect(diff(EXAMPLE, (t) => (stepAt(t, 1)['decode_errors'] = [1]))).toBe(
      "decode: the contract's answer does not match the interface: ?",
    );
    expect(
      diff(EXAMPLE, (t) => {
        const steps = t['steps'];
        if (Array.isArray(steps)) steps[1] = 'not a step';
      }),
    ).toBe('step: expected a "advance_time" step, got null');
  });

  it('fails a refusal with the wrong result or with events', () => {
    expect(diff(EXAMPLE, (t) => (stepAt(t, 3)['result'] = { error: 'MANDATE_REVOKED' }))).toBe(
      'result: expected {"error":"MANDATE_PAUSED"}, got {"error":"MANDATE_REVOKED"}',
    );
    expect(diff(EXAMPLE, (t) => (stepAt(t, 3)['events'] = [{ name: 'paused', fields: {} }]))).toBe(
      'events: expected none, got [{"name":"paused","fields":{}}]',
    );
    expect(diff(EXAMPLE, (t) => (stepAt(t, 3)['events'] = null))).toBe(
      'events: expected none, but the trace has no list',
    );
  });

  it('fails a wrong return value', () => {
    expect(diff(EXAMPLE, (t) => (stepAt(t, 6)['result'] = { ok: true, return: 'PENDING' }))).toBe(
      'return: expected "APPROVED", got "PENDING"',
    );
    expect(diff(EXAMPLE, (t) => (stepAt(t, 6)['result'] = { ok: true }))).toBe(
      'return: expected "APPROVED", got null',
    );
  });

  it('fails an extra, a missing, a reordered or a changed event', () => {
    const paused = { name: 'paused', fields: { by: 'guardian' } };
    expect(diff(EXAMPLE, (t) => (stepAt(t, 1)['events'] = [paused, paused]))).toBe(
      'events[1]: unexpected extra event paused',
    );
    expect(diff(EXAMPLE, (t) => (stepAt(t, 1)['events'] = []))).toBe(
      'events[0]: expected event paused, got no event: the event is missing',
    );
    expect(diff(EXAMPLE, (t) => (stepAt(t, 1)['events'] = null))).toBe(
      'events: the trace has no event list',
    );
    expect(
      diff(EXAMPLE, (t) => (stepAt(t, 1)['events'] = [{ name: 'resumed', fields: { by: 'x' } }])),
    ).toBe('events[0].name: expected paused, got resumed');
    expect(
      diff(RECOVERY, (t) => {
        const events = stepAt(t, 3)['events'];
        if (Array.isArray(events)) events.reverse();
      }),
    ).toMatch(/^events\[0\]\.name: expected .+: the events are out of order$/);
    expect(diff(EXAMPLE, (t) => (stepAt(t, 1)['events'] = [{ name: 'paused', fields: {} }]))).toBe(
      'events[0].fields.by: missing',
    );
    expect(
      diff(EXAMPLE, (t) => (stepAt(t, 1)['events'] = [{ name: 'paused', fields: { by: 'x' } }])),
    ).toBe('events[0].fields.by: expected "guardian", got "x"');
    expect(
      diff(
        EXAMPLE,
        (t) => (stepAt(t, 1)['events'] = [{ name: 'paused', fields: { by: 'guardian', x: 1 } }]),
      ),
    ).toBe('events[0].fields.x: not expected');
    expect(diff(EXAMPLE, (t) => (stepAt(t, 1)['events'] = [{ fields: 'none' }]))).toBe(
      'events[0].name: expected paused, got ?',
    );
  });

  it('fails a token event where the vector says no token moved', () => {
    const tokenStep = (t: JsonObject): JsonObject => {
      const steps = Array.isArray(t['steps']) ? t['steps'] : [];
      const i = steps.findIndex((s) => at(s, 'step') === 'transfer');
      return stepAt(t, i + 1);
    };
    expect(diff(FUNDING, (t) => (tokenStep(t)['events'] = [{ name: 'x', fields: {} }]))).toMatch(
      /^events: expected none/,
    );
    expect(diff(REVOKE, (t) => (stepAt(t, 2)['token_events'] = [{ token: 'asset' }]))).toMatch(
      /^token_events: expected none/,
    );
  });

  it('fails a state that differs on what the vector names, and only there', () => {
    expect(diff(EXAMPLE, (t) => (stepAt(t, 1)['state'] = null))).toBe(
      'state: expected state, but the trace has none: there is no mandate to read',
    );
    expect(
      diff(EXAMPLE, (t) => {
        const m = at(stepAt(t, 1)['state'] ?? null, 'mandate');
        if (m !== null && typeof m === 'object' && !Array.isArray(m)) m['paused'] = false;
      }),
    ).toMatch(/^(state\.mandate\.paused: expected true, got false|invariant: .*)$/);
    expect(
      diff(EXAMPLE, (t) => {
        const m = at(stepAt(t, 1)['state'] ?? null, 'mandate');
        if (m !== null && typeof m === 'object' && !Array.isArray(m)) delete m['paused'];
      }),
    ).toBe('state.mandate.paused: not recorded in the trace: the contract did not report it');
    expect(
      diff(EXAMPLE, (t) => {
        const s = stepAt(t, 6)['state'];
        if (s !== null && typeof s === 'object' && !Array.isArray(s)) s['mandate'] = 'x';
      }),
    ).toMatch(/^state\.mandate: expected /);
    expect(
      diff(EXAMPLE, (t) => {
        const s = stepAt(t, 6)['state'];
        if (s !== null && typeof s === 'object' && !Array.isArray(s)) s['payouts'] = {};
      }),
    ).toMatch(/^state\.payouts\.0x[0-9a-f]{64}: not recorded in the trace$/);
    expect(
      diff(EXAMPLE, (t) => {
        const p = at(stepAt(t, 6)['state'] ?? null, 'payouts');
        if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
          for (const k of Object.keys(p)) p[k] = null;
        }
      }),
    ).toMatch(/^(state\.payouts\.0x[0-9a-f]{64}: expected .*, got null|invariant: .*)$/);
    expect(
      diff(EXAMPLE, (t) => {
        const b = at(at(stepAt(t, 6)['state'] ?? null, 'balances'), 'asset');
        if (b !== null && typeof b === 'object' && !Array.isArray(b)) b['principal'] = '5';
      }),
    ).toMatch(/^(state\.balances\.asset\.principal: expected "0", got "5"|invariant: .*)$/);
  });

  it('fails a daily usage that is missing or differs', () => {
    const lastWithDaily = (t: JsonObject): JsonObject => {
      const raw = vector(DAILY).raw['steps'];
      const list = Array.isArray(raw) ? raw : [];
      let n = 0;
      list.forEach((s, i) => {
        if (at(at(at(s, 'expect'), 'state'), 'daily') !== null) n = i + 1;
      });
      return stepAt(t, n);
    };
    expect(
      diff(DAILY, (t) => {
        const s = lastWithDaily(t)['state'];
        if (s !== null && typeof s === 'object' && !Array.isArray(s)) s['daily'] = {};
      }),
    ).toMatch(/^state\.daily\.0x[0-9a-f]{64}: not recorded in the trace$/);
    expect(
      diff(DAILY, (t) => {
        const d = at(lastWithDaily(t)['state'] ?? null, 'daily');
        if (d !== null && typeof d === 'object' && !Array.isArray(d)) {
          for (const k of Object.keys(d)) d[k] = { day: '1', used: '0' };
        }
      }),
    ).toMatch(/^state\.daily\.0x[0-9a-f]{64}\.(day|used): expected /);
  });

  it('runs the invariants after every step', () => {
    expect(
      diff(EXAMPLE, (t) => {
        const m = at(stepAt(t, 2)['state'] ?? null, 'mandate');
        if (m !== null && typeof m === 'object' && !Array.isArray(m)) m['committed'] = '20000';
      }),
    ).toMatch(/^invariant: I1: /);
  });

  it('takes a per-chain override in place of the expected error', () => {
    const v = all.find((x) => JSON.stringify(x.raw).includes('host_auth_failure'));
    if (v === undefined) throw new Error('no vector with a host authorization failure');
    expect(compareVector(v.raw, runVector(v).trace, 'stellar')).toBe(undefined);
    const echo = echoTrace(v.raw, 'celo');
    // The other chain keeps the error around the override, so the Stellar
    // trace no longer matches it.
    expect(compareVector(v.raw, echo, 'stellar')).not.toBe(undefined);
  });
});

describe('the invariants', () => {
  function base(): JsonObject {
    return {
      mandate: {
        spent: '0',
        pending: '0',
        committed: '0',
        balance: '1000',
        revoked: false,
        expired: false,
        principal: 'principal',
        agents: ['agent'],
        approvers: ['a1'],
        executors: ['ex'],
        recovery: [],
        recovery_threshold: 0,
        limits: {
          total_budget: '1000',
          per_payment_cap: '500',
          per_recipient_daily_cap: '500',
          approval_threshold: '400',
        },
      },
      payouts: {},
      balances: { asset: { mandate: '1000', bob: '0', principal: '0', fee_address: '0' } },
      daily: {},
    };
  }

  function edit(state: JsonObject, path: string[], value: Json): JsonObject {
    const out = structuredClone(state);
    let node: Json = out;
    for (const key of path.slice(0, -1)) node = at(node, key);
    const last = path[path.length - 1] ?? '';
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) node[last] = value;
    return out;
  }

  function call(state: Json, events: Json[] = [], fn = 'execute', ok = true): JsonObject {
    return {
      step: 'call',
      fn,
      result: ok ? { ok: true } : { error: 'UNAUTHORIZED' },
      events,
      token_events: [],
      state,
    };
  }

  function check(prev: Json, ...steps: JsonObject[]): string {
    const checker = new Checker(prev);
    try {
      for (const s of steps) checker.afterStep(s);
      return 'held';
    } catch (error) {
      if (error instanceof InvariantViolation) return error.message;
      throw error;
    }
  }

  // With revoked unknown, I2 and I10 cannot be judged, so a case can break
  // exactly one other invariant.
  const loose = (): JsonObject => edit(base(), ['mandate', 'revoked'], null);

  const requested = (id: string, total: string, status: string): Json => ({
    name: 'payout_requested',
    fields: { payout_id: id, total, fee: '0', status },
  });
  const record = (status: string, total = '100'): Json => ({
    status,
    total,
    fee: '0',
    legs: [{ destination: { address: 'bob', tag: null }, amount: total }],
  });

  it('hold for a state that keeps them', () => {
    expect(check(base(), call(base()), { step: 'advance_time', state: null })).toBe('held');
    expect(check(null, call(null))).toBe('held');
  });

  it('I1, I2, I7 and I13 on the mandate', () => {
    expect(check(base(), call(edit(base(), ['mandate', 'spent'], '1001')))).toMatch(/^I1: /);
    expect(check(base(), call(edit(base(), ['mandate', 'balance'], 'x')))).toBe('held');
    expect(check(base(), call(edit(base(), ['mandate', 'pending'], '1')))).toMatch(/^I10: /);
    const held = edit(edit(base(), ['mandate', 'pending'], '600'), ['mandate', 'balance'], '500');
    expect(check(base(), call(held))).toMatch(/^I2: /);
    expect(check(base(), { step: 'clawback', from: 'mandate', state: base() }, call(held))).toMatch(
      /^I10: /,
    );
    const spent = edit(base(), ['mandate', 'spent'], '10');
    expect(check(spent, call(base()))).toMatch(/^I7: spent went down/);
    const revoked = edit(base(), ['mandate', 'revoked'], true);
    expect(check(revoked, call(base()))).toBe('I7: revoked was cleared');
    expect(check(base(), call(edit(base(), ['mandate', 'recovery_threshold'], 1)))).toMatch(
      /^I13: /,
    );
    expect(
      check(
        base(),
        call(
          edit(edit(base(), ['mandate', 'recovery'], ['r']), ['mandate', 'recovery_threshold'], 2),
        ),
      ),
    ).toMatch(/^I13: /);
  });

  it('I10 on the open payouts, and both zero once revoked', () => {
    const open = edit(
      edit(base(), ['mandate', 'pending'], '100'),
      ['payouts', '#p1'],
      record('PENDING'),
    );
    expect(check(base(), call(open, [requested('#p1', '100', 'PENDING')]))).toBe('held');
    const wrong = edit(open, ['mandate', 'pending'], '50');
    expect(check(base(), call(wrong))).toMatch(/^I10: pending 50/);
    const revokedOpen = edit(edit(open, ['mandate', 'revoked'], true), ['mandate', 'pending'], '1');
    expect(check(base(), call(revokedOpen))).toMatch(/^I10: revoked, yet/);
    const unknown = edit(open, ['mandate', 'revoked'], null);
    expect(check(base(), call(unknown))).toBe('held');
    const noAmounts = edit(open, ['payouts', '#p1'], { status: 'APPROVED' });
    expect(check(base(), call(noAmounts))).toBe('held');
    // A payout requested but not in the state makes the sum unknowable.
    expect(check(base(), call(base(), [requested('#p9', '100', 'APPROVED')]))).toBe('held');
  });

  it('I3 and I6 on the records', () => {
    const bad = edit(base(), ['payouts', '#p1'], {
      ...(record('EXECUTED') as JsonObject),
      total: '7',
    });
    expect(check(base(), call(bad))).toMatch(/^I3: the legs of/);
    const done = edit(loose(), ['payouts', '#p1'], record('EXECUTED'));
    expect(check(done, call(edit(loose(), ['payouts', '#p1'], null)))).toMatch(/now has none$/);
    expect(check(done, call(edit(loose(), ['payouts', '#p1'], record('APPROVED'))))).toMatch(
      /was EXECUTED and is now "APPROVED"$/,
    );
    expect(check(done, call(loose()))).toBe('held');
  });

  it('I9: a failed call emits nothing and changes nothing', () => {
    expect(check(base(), call(base(), [{ name: 'paused', fields: {} }], 'pause', false))).toMatch(
      /^I9: the call failed but emitted/,
    );
    expect(check(base(), { ...call(base(), [], 'pause', false), token_events: [{}] })).toBe(
      'I9: the call failed but a token emitted events',
    );
    expect(check(base(), call(edit(base(), ['mandate', 'spent'], '1'), [], 'pause', false))).toBe(
      'I9: the call failed but changed state.mandate.spent from "0" to "1"',
    );
    expect(check(base(), call(base(), [], 'pause', false))).toBe('held');
  });

  it('I5: the settlement asset leaves only to the payout, the fee address or the principal', () => {
    const paid = (bob: string, fee: string, principal = '0', mandate = '890'): JsonObject =>
      edit(base(), ['balances', 'asset'], { mandate, bob, principal, fee_address: fee });
    const executed: Json = {
      name: 'payout_executed',
      fields: {
        payout_id: '#p1',
        recipient_ref: '#bob',
        total: '100',
        fee: '10',
        legs: [{ destination: { address: 'bob', tag: null }, amount: '100' }],
        day: '1',
      },
    };
    expect(check(base(), call(paid('100', '10'), [executed]))).toBe('held');
    expect(check(base(), call(paid('100', '0', '10'), [executed]))).toMatch(
      /^I5: principal received 10/,
    );
    expect(check(base(), call(paid('100', '10', '0', '880'), [executed]))).toMatch(
      /^I5: 120 left the mandate but the step accounts for 110$/,
    );
    expect(check(base(), call(paid('0', '0', '110'), [], 'withdraw'))).toBe('held');
    expect(check(base(), call(paid('0', '0', '110'), [], 'pause'))).toMatch(
      /^I5: 110 of the settlement asset left the mandate during pause$/,
    );
    const noPrincipal = edit(base(), ['mandate', 'principal'], null);
    expect(check(noPrincipal, call(paid('0', '0', '110'), [], 'sweep'))).toMatch(/^(held|I.*)$/);
    expect(
      check(base(), call(edit(paid('100', '10'), ['balances', 'asset', 'bob'], 'x'), [executed])),
    ).toBe('held');
  });

  it('I3, I4, I6 and I8 on the events', () => {
    expect(check(base(), call(base(), [requested('#p1', '600', 'APPROVED')]))).toMatch(
      /^I3: payout .* charges 600 at request/,
    );
    expect(check(base(), call(base(), [requested('#p1', '450', 'APPROVED')]))).toMatch(
      /^I8: payout .* but was requested "APPROVED"$/,
    );
    const known = edit(loose(), ['payouts', '#p1'], record('PENDING'));
    expect(check(known, call(known, [requested('#p1', '100', 'APPROVED')]))).toMatch(
      /^I6: payout .* requested a second time$/,
    );
    const add = (who: string): Json => ({
      name: 'payout_approval_added',
      fields: { payout_id: '#p1', approver: who },
    });
    expect(check(base(), call(base(), [add('eve')]))).toMatch(
      /^I8: eve approved .* not an approver$/,
    );
    const agentApprover = edit(base(), ['mandate', 'approvers'], ['agent']);
    expect(check(agentApprover, call(agentApprover, [add('agent')]))).toMatch(
      /while an agent or an executor$/,
    );
    expect(check(base(), call(base(), [add('a1'), add('a1')]))).toMatch(
      /^I8: a1 approved .* twice$/,
    );
    const needs = requested('#p1', '450', 'PENDING');
    const approved: Json = { name: 'payout_approved', fields: { payout_id: '#p1' } };
    expect(check(base(), call(base(), [needs, approved]))).toMatch(/approved by no approver$/);
    expect(check(base(), call(base(), [needs, add('a1'), approved]))).toBe('held');
    const statusOnly = edit(base(), ['payouts', '#p1'], { status: 'APPROVED' });
    expect(check(base(), call(base(), [needs]), call(statusOnly))).toMatch(
      /approved by no approver$/,
    );
    const exec = (total: string, day = '1'): Json => ({
      name: 'payout_executed',
      fields: { payout_id: '#p1', recipient_ref: '#bob', total, fee: '0', day },
    });
    expect(check(base(), call(base(), [exec('600')]))).toMatch(/^I3: .* charges 600 at execute/);
    expect(check(base(), call(base(), [exec('100'), exec('100')]))).toMatch(
      /^I6: payout .* executed twice$/,
    );
    const two: Json = { ...(exec('300') as JsonObject) };
    const other: Json = {
      name: 'payout_executed',
      fields: { payout_id: '#p2', recipient_ref: '#bob', total: '300', fee: '0', day: '1' },
    };
    expect(check(base(), call(base(), [two, other]))).toMatch(
      /^I4: recipient .* above the cap 500$/,
    );
    const noTotal: Json = { name: 'payout_executed', fields: { payout_id: '#p3' } };
    expect(check(base(), call(base(), [noTotal]))).toBe('held');
  });
});

describe('the value helpers', () => {
  it('compare JSON as maps and lists', () => {
    expect(equal({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(equal({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(equal({ a: 1 }, { b: 1 })).toBe(false);
    expect(equal([1], [1, 2])).toBe(false);
    expect(equal([1], { 0: 1 })).toBe(false);
    expect(show(undefined)).toBe('null');
    expect(amountOf('-170141183460469231731687303715884105728')).toBe(-(1n << 127n));
    expect(amountOf('170141183460469231731687303715884105728')).toBe(undefined);
    expect(amountOf(5)).toBe(undefined);
  });

  it('find the first difference with both sides', () => {
    expect(firstDifference({ a: 1 }, { a: 1 }, 's')).toBe(undefined);
    expect(firstDifference({ a: 1 }, {}, 's')).toEqual({
      path: 's.a',
      left: '1',
      right: 'nothing',
    });
    expect(firstDifference({}, { b: 2 }, 's')).toEqual({
      path: 's.b',
      left: 'nothing',
      right: '2',
    });
    expect(firstDifference([1], [1, 2], 's')).toEqual({
      path: 's[1]',
      left: 'nothing',
      right: '2',
    });
    expect(firstDifference([1, 2], [1], 's')).toEqual({
      path: 's[1]',
      left: '2',
      right: 'nothing',
    });
    expect(firstDifference([{ a: 1 }], [{ a: 2 }], 's')?.path).toBe('s[0].a');
    expect(firstDifference([1], [1], 's')).toBe(undefined);
    expect(firstDifference('x', 'y', 's')).toEqual({ path: 's', left: '"x"', right: '"y"' });
  });

  it('canonicalise labels, hex and attesters to the bytes they stand for', () => {
    const p1 = `0x${Buffer.from(labelBytes('#p1')).toString('hex')}`;
    expect(canon({ payouts: { '#p1': { status: 'APPROVED' } }, x: ['#p1'] })).toEqual(
      canon({ payouts: { [p1]: { status: 'APPROVED' } }, x: [p1] }),
    );
    expect(canon({ by: 'guardian', amount: '100', tag: null })).toEqual({
      by: 'guardian',
      amount: '100',
      tag: null,
    });
    expect(canon({ attester: null })).toEqual({ attester: null });
    expect(canon({ attester: '0x0102' })).toEqual({ attester: '0x0102' });
    expect(canon({ attester: { account_key: 'agent' } })).toEqual(
      canon({ attester: { account_key: 'agent' } }),
    );
    expect(canon({ payouts: [] })).toEqual({ payouts: [] });
    expect(() => canon({ attester: { other: 'x' } })).toThrow('is not an attester');
    expect(() => canon({ payout_id: '0x12' })).toThrow('is not 32 bytes');
    expect(() => canon({ payouts: { nolabel: 1 } })).toThrow('is not 32 bytes');
    expect(canonOrRaw({ payout_id: 'nolabel' })).toEqual({ payout_id: 'nolabel' });
    expect(() => labelBytes('p1')).toThrow('is not a label');
  });
});
