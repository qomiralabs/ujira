// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Compares a trace with the vector it ran, with the contracts' comparator's
// semantics: every call's result must be the expected one, a per-chain
// override replacing it; its events must be exactly the expected list in
// order; token_events: [] means no token emitted anything; state is matched
// only on the keys it names, lists in order, role sets included. The
// invariants run after every step. The first difference ends the
// comparison and names the vector, the step and the field.

import { canonKey, canonOrRaw } from './canon.js';
import { Checker, InvariantViolation } from './invariants.js';
import { at, equal, isObject, show } from './json.js';
import type { Json, JsonObject } from './json.js';

export interface Mismatch {
  readonly vector: string;
  /** 1-based; null for the vector as a whole. */
  readonly step: number | null;
  /** The function of a call step, or the step kind. */
  readonly what: string;
  /** A path such as events[1].fields.by or state.mandate.free. */
  readonly field: string;
  readonly detail: string;
}

export function describeMismatch(m: Mismatch): string {
  return m.step === null
    ? `vector ${m.vector}: ${m.field}: ${m.detail}`
    : `vector ${m.vector}, step ${String(m.step)} (${m.what}): ${m.field}: ${m.detail}`;
}

class Diff extends Error {
  constructor(
    readonly field: string,
    readonly detail: string,
  ) {
    super(`${field}: ${detail}`);
  }
}

function list(value: Json): Json[] {
  return Array.isArray(value) ? value : [];
}

/** Compares one vector's trace with the vector, on `chain`. */
export function compareVector(v: JsonObject, tv: JsonObject, chain: string): Mismatch | undefined {
  const idValue = at(v, 'id');
  const id = typeof idValue === 'string' ? idValue : show(idValue);
  const whole = (field: string, detail: string): Mismatch => ({
    vector: id,
    step: null,
    what: 'vector',
    field,
    detail,
  });
  const reason = (): string => {
    const r = at(tv, 'reason');
    return typeof r === 'string' ? r : 'no reason given';
  };
  if (at(tv, 'id') !== id) return whole('id', `the trace is for ${show(at(tv, 'id'))}`);
  const expected = list(at(v, 'steps'));
  const actual = list(at(tv, 'steps'));
  const status = at(tv, 'status');
  if (status !== 'ran' && status !== 'aborted') {
    return whole(
      'status',
      `the vector was ${typeof status === 'string' ? status : ''}: ${reason()}`,
    );
  }
  let checker: Checker;
  try {
    checker = new Checker(at(tv, 'setup_state'));
  } catch (error) {
    return whole('setup_state', error instanceof Error ? error.message : String(error));
  }
  for (const [i, exp] of expected.entries()) {
    const n = i + 1;
    const fn = at(exp, 'fn');
    const kind = at(exp, 'step');
    const what = typeof fn === 'string' ? fn : typeof kind === 'string' ? kind : '?';
    const act = actual[i];
    if (act === undefined) {
      const detail =
        status === 'aborted'
          ? `the run stopped before this step: ${reason()}`
          : 'the trace has no record of this step';
      return { vector: id, step: n, what, field: 'step', detail };
    }
    try {
      compareStep(exp, act, n, chain);
      if (!isObject(act)) throw new Diff('step', 'the trace step is not an object');
      checker.afterStep(act);
    } catch (error) {
      if (error instanceof Diff) {
        return { vector: id, step: n, what, field: error.field, detail: error.detail };
      }
      if (error instanceof InvariantViolation) {
        return { vector: id, step: n, what, field: 'invariant', detail: error.message };
      }
      throw error;
    }
  }
  if (actual.length > expected.length) {
    return whole(
      'steps',
      `the trace has ${String(actual.length)} steps, the vector ${String(expected.length)}`,
    );
  }
  if (status === 'aborted') return whole('status', `the run was aborted: ${reason()}`);
  return undefined;
}

function compareStep(exp: Json, act: Json, n: number, chain: string): void {
  if (!equal(at(act, 'step'), at(exp, 'step'))) {
    throw new Diff(
      'step',
      `expected a ${show(at(exp, 'step'))} step, got ${show(at(act, 'step'))}`,
    );
  }
  if (at(act, 'index') !== n) {
    throw new Diff('index', `expected ${String(n)}, got ${show(at(act, 'index'))}`);
  }
  const kind = at(exp, 'step');
  if (kind === 'call') compareCall(exp, act, chain);
  else if (kind === 'transfer' && isObject(exp) && Object.hasOwn(exp, 'events')) {
    noEvents(act, 'events');
  }
}

function noEvents(act: Json, key: string): void {
  const got = at(act, key);
  if (!Array.isArray(got)) throw new Diff(key, 'expected none, but the trace has no list');
  if (got.length > 0) throw new Diff(key, `expected none, got ${show(got)}`);
}

function compareCall(exp: Json, act: Json, chain: string): void {
  for (const key of ['fn', 'caller']) {
    if (!equal(at(act, key), at(exp, key))) {
      throw new Diff(key, `expected ${show(at(exp, key))}, got ${show(at(act, key))}`);
    }
  }
  const decode = list(at(act, 'decode_errors'))[0];
  if (decode !== undefined) {
    throw new Diff(
      'decode',
      `the contract's answer does not match the interface: ${typeof decode === 'string' ? decode : '?'}`,
    );
  }
  const e = at(exp, 'expect');
  const result = at(act, 'result');
  const override = at(at(e, 'per_chain'), chain);
  const error = at(e, 'error');
  let refusal: Json | undefined;
  if (isObject(override)) refusal = { ...override };
  else if (typeof error === 'string') refusal = { error };
  if (refusal !== undefined) {
    if (!equal(result, refusal)) {
      throw new Diff('result', `expected ${show(refusal)}, got ${show(result)}`);
    }
    noEvents(act, 'events');
    return;
  }
  if (at(result, 'ok') !== true) {
    throw new Diff('result', `expected the call to succeed, got ${show(result)}`);
  }
  if (isObject(e) && Object.hasOwn(e, 'return')) {
    const want = at(e, 'return');
    const got = at(result, 'return');
    if (!equal(canonOrRaw(want), canonOrRaw(got))) {
      throw new Diff('return', `expected ${show(want)}, got ${show(got)}`);
    }
  }
  compareEvents(at(e, 'events'), at(act, 'events'));
  if (isObject(e) && Object.hasOwn(e, 'token_events')) noEvents(act, 'token_events');
  if (isObject(e) && Object.hasOwn(e, 'state')) compareState(at(e, 'state'), at(act, 'state'));
}

function eventName(e: Json | undefined): string {
  const name = at(e, 'name');
  return typeof name === 'string' ? name : '?';
}

/** Exhaustive and ordered: a missing, extra or moved event is a difference. */
export function compareEvents(expected: Json, actual: Json): void {
  const exp = list(expected);
  if (!Array.isArray(actual)) throw new Diff('events', 'the trace has no event list');
  for (let i = 0; i < Math.max(exp.length, actual.length); i += 1) {
    const field = `events[${String(i)}]`;
    const e = exp[i];
    const a = actual[i];
    if (a === undefined) {
      throw new Diff(field, `expected event ${eventName(e)}, got no event: the event is missing`);
    }
    if (e === undefined) throw new Diff(field, `unexpected extra event ${eventName(a)}`);
    const en = eventName(e);
    const an = eventName(a);
    if (en !== an) {
      const moved = exp.some((x) => eventName(x) === an) && actual.some((x) => eventName(x) === en);
      throw new Diff(
        `${field}.name`,
        `expected ${en}, got ${an}${moved ? ': the events are out of order' : ''}`,
      );
    }
    compareExact(canonOrRaw(at(e, 'fields')), canonOrRaw(at(a, 'fields')), `${field}.fields`);
  }
}

/** Every key on both sides, and equal values. */
function compareExact(want: Json, got: Json, path: string): void {
  if (isObject(want) && isObject(got)) {
    for (const [k, wv] of Object.entries(want)) {
      if (!Object.hasOwn(got, k)) throw new Diff(`${path}.${k}`, 'missing');
      if (!equal(got[k], wv)) {
        throw new Diff(`${path}.${k}`, `expected ${show(wv)}, got ${show(got[k])}`);
      }
    }
    const extra = Object.keys(got).find((k) => !Object.hasOwn(want, k));
    if (extra !== undefined) throw new Diff(`${path}.${extra}`, 'not expected');
    return;
  }
  if (!equal(want, got)) throw new Diff(path, `expected ${show(want)}, got ${show(got)}`);
}

/** Only what `want` names is compared. */
function comparePartial(want: Json, got: Json, path: string): void {
  if (!isObject(want)) {
    if (!equal(want, got)) throw new Diff(path, `expected ${show(want)}, got ${show(got)}`);
    return;
  }
  if (!isObject(got)) throw new Diff(path, `expected ${show(want)}, got ${show(got)}`);
  for (const [k, wv] of Object.entries(want)) {
    if (!Object.hasOwn(got, k)) {
      throw new Diff(`${path}.${k}`, 'not recorded in the trace: the contract did not report it');
    }
    if (!equal(got[k], wv)) {
      throw new Diff(`${path}.${k}`, `expected ${show(wv)}, got ${show(got[k])}`);
    }
  }
}

function canonKeyOrRaw(key: string): string {
  try {
    return canonKey(key);
  } catch {
    return key;
  }
}

export function compareState(wantRaw: Json, gotRaw: Json): void {
  if (gotRaw === null) {
    throw new Diff('state', 'expected state, but the trace has none: there is no mandate to read');
  }
  const want = canonOrRaw(wantRaw);
  const got = canonOrRaw(gotRaw);
  if (isObject(want) && Object.hasOwn(want, 'mandate')) {
    comparePartial(at(want, 'mandate'), at(got, 'mandate'), 'state.mandate');
  }
  const payouts = at(want, 'payouts');
  if (isObject(payouts)) {
    const gotPayouts = at(got, 'payouts');
    for (const [id, wv] of Object.entries(payouts)) {
      const key = canonKeyOrRaw(id);
      const path = `state.payouts.${id}`;
      if (!isObject(gotPayouts) || !Object.hasOwn(gotPayouts, key)) {
        throw new Diff(path, 'not recorded in the trace');
      }
      const gv = gotPayouts[key] ?? null;
      if (wv === null || gv === null) {
        if (!equal(wv, gv)) throw new Diff(path, `expected ${show(wv)}, got ${show(gv)}`);
        continue;
      }
      comparePartial(wv, gv, path);
    }
  }
  const balances = at(want, 'balances');
  if (isObject(balances)) {
    for (const [token, holders] of Object.entries(balances)) {
      comparePartial(holders, at(at(got, 'balances'), token), `state.balances.${token}`);
    }
  }
  const daily = at(want, 'daily');
  if (isObject(daily)) {
    const gotDaily = at(got, 'daily');
    for (const [ref, wv] of Object.entries(daily)) {
      const key = canonKeyOrRaw(ref);
      const path = `state.daily.${ref}`;
      if (!isObject(gotDaily) || !Object.hasOwn(gotDaily, key)) {
        throw new Diff(path, 'not recorded in the trace');
      }
      compareExact(wv, gotDaily[key] ?? null, path);
    }
  }
}

/**
 * The trace a chain that did exactly what `v` expects would write. The
 * state is only what the vector states: after a successful call, what it
 * expects then; after a refused call, the same as before; unknown (null)
 * after any other step. The comparator's self tests start from it and
 * change one thing at a time.
 */
export function echoTrace(v: JsonObject, chain: string): JsonObject {
  let state: Json = null;
  const steps: Json[] = [];
  for (const [i, s] of list(at(v, 'steps')).entries()) {
    const rec: JsonObject = isObject(s) ? { ...s } : {};
    delete rec['expect'];
    rec['index'] = i + 1;
    rec['now'] = '0';
    const e = at(s, 'expect');
    if (at(s, 'step') === 'call') {
      const override = at(at(e, 'per_chain'), chain);
      const error = at(e, 'error');
      let result: Json;
      if (override !== null) result = override;
      else if (typeof error === 'string') result = { error };
      else result = { ok: true, return: at(e, 'return') };
      rec['result'] = result;
      rec['events'] = list(at(e, 'events'));
      rec['token_events'] = [];
      if (override === null && error === null) state = at(e, 'state');
    } else {
      state = null;
      if (at(s, 'step') === 'transfer') {
        rec['events'] = [];
        rec['token_events'] = [];
      }
    }
    rec['state'] = state;
    steps.push(rec);
  }
  return {
    id: at(v, 'id'),
    status: 'ran',
    actors: {},
    setup_state: null,
    steps,
  };
}
