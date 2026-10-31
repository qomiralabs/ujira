// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The spec's invariants I1 to I10 and I13, checked after every step of a
// trace exactly as the contracts' runner checks them. Each check reads only
// the trace: the state before and after the step, its result and its
// events. A check whose inputs the trace does not have, for example before
// the mandate exists, is skipped for that step; a missing field a vector
// expects is the comparator's to report.

import { canon } from './canon.js';
import { firstDifference } from './diff.js';
import { amountOf, at, isObject } from './json.js';
import type { Json, JsonObject } from './json.js';

const TERMINAL: ReadonlySet<string> = new Set(['EXECUTED', 'REJECTED', 'CANCELLED']);

export class InvariantViolation extends Error {
  override readonly name = 'InvariantViolation';
  constructor(invariant: string, detail: string) {
    super(`${invariant}: ${detail}`);
  }
}

function fail(invariant: string, detail: string): never {
  throw new InvariantViolation(invariant, detail);
}

function names(list: Json): Set<string> {
  return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
}

function charged(fields: Json): bigint | undefined {
  const total = amountOf(at(fields, 'total'));
  const fee = amountOf(at(fields, 'fee'));
  return total === undefined || fee === undefined ? undefined : total + fee;
}

function entries(value: Json): [string, Json][] {
  return isObject(value) ? Object.entries(value) : [];
}

function text(value: Json): string {
  return typeof value === 'string' ? value : '';
}

/** Carries what the invariants need from one step to the next. */
export class Checker {
  #prev: Json;
  readonly #executed = new Set<string>();
  readonly #needsApproval = new Set<string>();
  readonly #approvals = new Map<string, Set<string>>();
  readonly #executedPerDay = new Map<string, bigint>();
  /** Set once the asset itself took the mandate's balance, after which I2 need not hold. */
  #assetIntervened = false;
  /** Every payout ID a payout_requested event has named. */
  readonly #requested = new Set<string>();

  constructor(setupState: Json) {
    this.#prev = canon(setupState);
  }

  /** Checks the invariants after one recorded step; throws the first violation. */
  afterStep(step: JsonObject): void {
    const cur = canon(at(step, 'state'));
    const evs = canon(at(step, 'events'));
    const events = Array.isArray(evs) ? evs : [];
    const kind = text(at(step, 'step'));
    const isCall = kind === 'call';
    const ok = at(at(step, 'result'), 'ok') === true;
    const prev = this.#prev;
    this.#prev = null;

    if (isCall && !ok) failedCallChangesNothing(step, events, prev, cur);
    for (const e of events.filter((x) => at(x, 'name') === 'payout_requested')) {
      const id = at(at(e, 'fields'), 'payout_id');
      if (typeof id === 'string') this.#requested.add(id);
    }
    if (kind === 'clawback' && at(step, 'from') === 'mandate') this.#assetIntervened = true;
    if (cur !== null) {
      const m = at(cur, 'mandate');
      i1(m);
      i13(m);
      i7(at(prev, 'mandate'), m);
      if (!this.#assetIntervened) i2(m);
      // The sums are only known when every payout requested so far has its
      // record in the state.
      const payouts = at(cur, 'payouts');
      const allRecorded = [...this.#requested].every(
        (id) => isObject(payouts) && Object.hasOwn(payouts, id),
      );
      if (allRecorded) i10(m, payouts);
      i3Records(payouts);
      i6Records(at(prev, 'payouts'), payouts);
      if (prev !== null && isCall && ok) i5(step, events, prev, cur);
    }
    if (prev !== null) this.#events(events, prev);
    if (cur !== null) this.#i8Status(at(cur, 'payouts'));
    this.#prev = cur;
  }

  /** I3 and I4 at execution, I6 on reuse and repeated execution, I8 on approvals. */
  #events(events: readonly Json[], prev: Json): void {
    const limits = at(at(prev, 'mandate'), 'limits');
    const cap = amountOf(at(limits, 'per_payment_cap'));
    const threshold = amountOf(at(limits, 'approval_threshold'));
    const dailyCap = amountOf(at(limits, 'per_recipient_daily_cap'));
    for (const e of events) {
      const f = at(e, 'fields');
      const id = text(at(f, 'payout_id'));
      switch (at(e, 'name')) {
        case 'payout_requested': {
          if (at(at(prev, 'payouts'), id) !== null) {
            fail('I6', `payout ${id} was requested a second time`);
          }
          const c = charged(f);
          if (c !== undefined && cap !== undefined && c > cap) {
            fail(
              'I3',
              `payout ${id} charges ${String(c)} at request, above the cap ${String(cap)}`,
            );
          }
          if (c !== undefined && threshold !== undefined && c >= threshold) {
            if (at(f, 'status') !== 'PENDING') {
              fail(
                'I8',
                `payout ${id} charges ${String(c)}, at or above the approval threshold ${String(threshold)}, but was requested ${JSON.stringify(at(f, 'status'))}`,
              );
            }
            this.#needsApproval.add(id);
          }
          break;
        }
        case 'payout_approval_added': {
          const who = text(at(f, 'approver'));
          const m = at(prev, 'mandate');
          if (isObject(m) && Object.hasOwn(m, 'approvers') && !names(at(m, 'approvers')).has(who)) {
            fail('I8', `${who} approved ${id} but is not an approver`);
          }
          if (names(at(m, 'agents')).has(who) || names(at(m, 'executors')).has(who)) {
            fail('I8', `${who} approved ${id} while an agent or an executor`);
          }
          const given = this.#approvals.get(id) ?? new Set<string>();
          if (given.has(who)) fail('I8', `${who} approved ${id} twice`);
          given.add(who);
          this.#approvals.set(id, given);
          break;
        }
        case 'payout_approved':
          this.#hasApprovals(id);
          break;
        case 'payout_executed': {
          if (this.#executed.has(id)) fail('I6', `payout ${id} was executed twice`);
          this.#executed.add(id);
          const c = charged(f);
          if (c !== undefined && cap !== undefined && c > cap) {
            fail(
              'I3',
              `payout ${id} charges ${String(c)} at execute, above the cap ${String(cap)}`,
            );
          }
          const ref = text(at(f, 'recipient_ref'));
          const day = text(at(f, 'day'));
          const total = amountOf(at(f, 'total'));
          if (total !== undefined) {
            const key = `${ref}|${day}`;
            const used = (this.#executedPerDay.get(key) ?? 0n) + total;
            this.#executedPerDay.set(key, used);
            if (dailyCap !== undefined && used > dailyCap) {
              fail(
                'I4',
                `recipient ${ref} has ${String(used)} executed on day ${day}, above the cap ${String(dailyCap)}`,
              );
            }
          }
          break;
        }
        default:
          break;
      }
    }
  }

  #hasApprovals(id: string): void {
    if (this.#needsApproval.has(id) && (this.#approvals.get(id)?.size ?? 0) === 0) {
      fail('I8', `payout ${id} needed approval but was approved by no approver`);
    }
  }

  /** I8 on the records: a payout that needed approval only reaches APPROVED or EXECUTED through one. */
  #i8Status(payouts: Json): void {
    for (const id of this.#needsApproval) {
      const status = at(at(payouts, id), 'status');
      if (status === 'APPROVED' || status === 'EXECUTED') this.#hasApprovals(id);
    }
  }
}

/** I9: a failed call emits nothing and changes nothing. */
function failedCallChangesNothing(
  step: JsonObject,
  events: readonly Json[],
  prev: Json,
  cur: Json,
): void {
  const first = events[0];
  if (first !== undefined) {
    fail('I9', `the call failed but emitted ${JSON.stringify(at(first, 'name'))}`);
  }
  const tokens = at(step, 'token_events');
  if (Array.isArray(tokens) && tokens.length > 0) {
    fail('I9', 'the call failed but a token emitted events');
  }
  const d = firstDifference(prev, cur, 'state');
  if (d !== undefined) {
    fail('I9', `the call failed but changed ${d.path} from ${d.left} to ${d.right}`);
  }
}

/**
 * I5: the settlement asset leaves the mandate only through execute, to the
 * payout's destinations and the fee address, and through withdraw and
 * sweep, to the principal.
 */
function i5(step: JsonObject, events: readonly Json[], prev: Json, cur: Json): void {
  const before = at(at(prev, 'balances'), 'asset');
  const after = at(at(cur, 'balances'), 'asset');
  const b = amountOf(at(before, 'mandate'));
  const a = amountOf(at(after, 'mandate'));
  if (b === undefined || a === undefined || a >= b) return;
  const out = b - a;
  const credits = new Map<string, bigint>();
  const credit = (holder: string, n: bigint): void => {
    credits.set(holder, (credits.get(holder) ?? 0n) + n);
  };
  const fn = text(at(step, 'fn'));
  if (fn === 'execute' || fn === 'execute_batch') {
    for (const e of events.filter((x) => at(x, 'name') === 'payout_executed')) {
      const f = at(e, 'fields');
      const legs = at(f, 'legs');
      for (const leg of Array.isArray(legs) ? legs : []) {
        credit(text(at(at(leg, 'destination'), 'address')), amountOf(at(leg, 'amount')) ?? 0n);
      }
      const fee = amountOf(at(f, 'fee')) ?? 0n;
      if (fee > 0n) credit('fee_address', fee);
    }
  } else if (fn === 'withdraw' || fn === 'sweep') {
    // Without the principal there is no one to check the credit against.
    const principal = at(at(prev, 'mandate'), 'principal');
    if (typeof principal !== 'string') return;
    credit(principal, out);
  } else {
    fail('I5', `${String(out)} of the settlement asset left the mandate during ${fn}`);
  }
  const paid = [...credits.values()].reduce((sum, n) => sum + n, 0n);
  if (paid !== out) {
    fail('I5', `${String(out)} left the mandate but the step accounts for ${String(paid)}`);
  }
  for (const [holder, now] of entries(after)) {
    if (holder === 'mandate') continue;
    const x = amountOf(at(before, holder));
    const y = amountOf(now);
    if (x === undefined || y === undefined) continue;
    const want = credits.get(holder) ?? 0n;
    if (y - x !== want) {
      fail(
        'I5',
        `${holder} received ${String(y - x)} of the settlement asset, expected ${String(want)}`,
      );
    }
  }
}

/** I13: the recovery threshold is 0 exactly when the set is empty, else 1 to its size. */
function i13(m: Json): void {
  const set = at(m, 'recovery');
  const t = at(m, 'recovery_threshold');
  if (!Array.isArray(set) || typeof t !== 'number') return;
  const n = set.length;
  const fits = n === 0 ? t === 0 : t >= 1 && t <= n;
  if (!fits)
    fail('I13', `the recovery threshold is ${String(t)} with ${String(n)} recovery approvers`);
}

/** I1: spent + pending + committed <= total_budget. */
function i1(m: Json): void {
  const s = amountOf(at(m, 'spent'));
  const p = amountOf(at(m, 'pending'));
  const c = amountOf(at(m, 'committed'));
  const budget = amountOf(at(at(m, 'limits'), 'total_budget'));
  if (s === undefined || p === undefined || c === undefined || budget === undefined) return;
  if (s + p + c > budget) {
    fail(
      'I1',
      `spent ${String(s)} + pending ${String(p)} + committed ${String(c)} is above the budget ${String(budget)}`,
    );
  }
}

/** I2: while active, balance >= pending + committed. */
function i2(m: Json): void {
  if (at(m, 'revoked') !== false || at(m, 'expired') !== false) return;
  const bal = amountOf(at(m, 'balance'));
  const p = amountOf(at(m, 'pending'));
  const c = amountOf(at(m, 'committed'));
  if (bal === undefined || p === undefined || c === undefined) return;
  if (bal < p + c) {
    fail(
      'I2',
      `the active mandate holds ${String(bal)}, below pending ${String(p)} + committed ${String(c)}`,
    );
  }
}

/** I7: spent never decreases and revoked never clears. */
function i7(before: Json, after: Json): void {
  const x = amountOf(at(before, 'spent'));
  const y = amountOf(at(after, 'spent'));
  if (x !== undefined && y !== undefined && y < x) {
    fail('I7', `spent went down from ${String(x)} to ${String(y)}`);
  }
  if (at(before, 'revoked') === true && at(after, 'revoked') === false) {
    fail('I7', 'revoked was cleared');
  }
}

/** I10: pending and committed are the charges of the PENDING and APPROVED payouts. */
function i10(m: Json, payouts: Json): void {
  const p = amountOf(at(m, 'pending'));
  const c = amountOf(at(m, 'committed'));
  if (p === undefined || c === undefined) return;
  if (at(m, 'revoked') === true) {
    if (p !== 0n || c !== 0n) {
      fail('I10', `revoked, yet pending is ${String(p)} and committed is ${String(c)}`);
    }
    return;
  }
  // Revoke zeroes both without touching the records, so the sums only hold
  // when the state says the mandate is not revoked.
  if (at(m, 'revoked') !== false) return;
  let wantP = 0n;
  let wantC = 0n;
  for (const [, rec] of entries(payouts)) {
    const status = at(rec, 'status');
    if (status !== 'PENDING' && status !== 'APPROVED') continue;
    const ch = charged(rec);
    // A record without its amounts makes the sum unknowable.
    if (ch === undefined) return;
    if (status === 'PENDING') wantP += ch;
    else wantC += ch;
  }
  if (p !== wantP || c !== wantC) {
    fail(
      'I10',
      `pending ${String(p)} and committed ${String(c)}, but the open payouts charge ${String(wantP)} pending and ${String(wantC)} approved`,
    );
  }
}

/** I3 on the records: the legs of every payout sum to its total. */
function i3Records(payouts: Json): void {
  for (const [id, rec] of entries(payouts)) {
    const legs = at(rec, 'legs');
    const total = amountOf(at(rec, 'total'));
    if (!Array.isArray(legs) || total === undefined) continue;
    let sum: bigint | undefined = 0n;
    for (const leg of legs) {
      const n = amountOf(at(leg, 'amount'));
      sum = sum === undefined || n === undefined ? undefined : sum + n;
    }
    if (sum !== total) fail('I3', `the legs of ${id} do not sum to its total ${String(total)}`);
  }
}

/** I6 on the records: a terminal status never changes and a used ID never becomes unused. */
function i6Records(before: Json, after: Json): void {
  for (const [id, old] of entries(before)) {
    if (old === null) continue;
    // A payout the state does not mention is not known either way; one
    // recorded as null has no record.
    if (!isObject(after) || !Object.hasOwn(after, id)) continue;
    const next = after[id] ?? null;
    if (next === null) fail('I6', `payout ${id} had a record and now has none`);
    const was = text(at(old, 'status'));
    if (TERMINAL.has(was) && at(next, 'status') !== was) {
      fail('I6', `payout ${id} was ${was} and is now ${JSON.stringify(at(next, 'status'))}`);
    }
  }
}
