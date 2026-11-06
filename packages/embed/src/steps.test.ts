// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { encodeAccountAddress } from './destination.js';
import { PAYOUT_METHODS, type MethodId, type PayoutMethod } from './methods.js';
import {
  CONNECTED_STEPS,
  VERIFIED_STEPS,
  findProblem,
  firstStep,
  HANDED,
  initialAnswers,
  isQuestionStep,
  nextStep,
  offered,
  previousStep,
  problem,
  QUESTION_STEPS,
  shortLabel,
  stepCount,
  stepNumber,
  STEP_IDS,
  type Answers,
  type Flow,
} from './steps.js';

const WALLET = encodeAccountAddress(new Uint8Array(32).fill(7));
const ISSUER = encodeAccountAddress(new Uint8Array(32).fill(9));

function withOpen(ids: readonly MethodId[]): readonly PayoutMethod[] {
  return PAYOUT_METHODS.map((method) => ({ ...method, open: ids.includes(method.id) }));
}

function handed(methods: readonly PayoutMethod[]): Flow {
  return { ...HANDED, methods };
}

const CONNECTED: Flow = {
  connected: true,
  methods: PAYOUT_METHODS,
  corridor: ['stellar_wallet'],
  neverPayable: [ISSUER],
};

function answers(fields: Partial<Answers> = {}): Answers {
  return { name: 'Amara Eze', method: 'wallet', destination: WALLET, memo: '', ...fields };
}

describe('step framework', () => {
  it('counts only the steps a person answers', () => {
    expect(STEP_IDS).toEqual([
      'name',
      'method',
      'verify',
      'destination',
      'review',
      'prove',
      'activate',
      'done',
    ]);
    expect(QUESTION_STEPS).toEqual(['name', 'method', 'destination', 'review']);
    expect(stepCount()).toBe(4);
    expect(stepNumber('destination')).toBe(3);
    expect(isQuestionStep('done')).toBe(false);
    expect(isQuestionStep('prove')).toBe(false);
  });

  it('moves forward and back, and stops at the ends', () => {
    expect(firstStep()).toBe('name');
    expect(nextStep('name')).toBe('method');
    expect(nextStep('review')).toBe('done');
    expect(nextStep('done')).toBe('done');
    expect(previousStep('method')).toBe('name');
    expect(previousStep('name')).toBeUndefined();
  });

  it('names a step for the back and change controls', () => {
    expect(shortLabel('name')).toBe('step.name.short');
    expect(shortLabel('done')).toBeUndefined();
    expect(shortLabel('prove')).toBeUndefined();
  });

  it('chooses the only open method for the person', () => {
    expect(initialAnswers()).toEqual({ name: '', method: 'wallet', destination: '', memo: '' });
  });

  it('leaves the method unchosen when several are open', () => {
    expect(initialAnswers(handed(withOpen(['wallet', 'bank']))).method).toBe('');
  });

  it('leaves the method unchosen when none is open', () => {
    expect(initialAnswers(handed(withOpen([]))).method).toBe('');
  });

  it('asks for a name before moving on', () => {
    expect(problem('name', answers({ name: '   ' }))).toBe('name.missing');
    expect(problem('name', answers())).toBeUndefined();
  });

  it('asks for a method that is open', () => {
    expect(problem('method', answers({ method: '' }))).toBe('method.missing');
    expect(problem('method', answers({ method: 'bank' }))).toBe('method.missing');
    expect(problem('method', answers())).toBeUndefined();
  });

  it('reads an answer that is only spaces as missing', () => {
    expect(problem('destination', answers({ destination: '  ' }))).toBe(
      'destination.wallet.missing',
    );
  });

  it('says what is wrong with an address that is not a Stellar address', () => {
    expect(problem('destination', answers({ destination: 'GABC' }))).toBe(
      'destination.wallet.invalid',
    );
    expect(problem('destination', answers({ destination: `G${'A'.repeat(55)}` }))).toBe(
      'destination.wallet.invalid',
    );
    expect(problem('destination', answers({ destination: ` ${WALLET} ` }))).toBeUndefined();
  });

  it('marks the memo field, not the address, when the memo is what is wrong', () => {
    expect(findProblem('destination', answers({ memo: 'invoice 12' }))).toEqual({
      key: 'destination.memo.unsupported',
      field: 'memo',
    });
    expect(findProblem('destination', answers({ destination: 'GABC' }))?.field).toBe('answer');
  });

  it('checks an anchor method by its shape, once it is open', () => {
    const flow = handed(withOpen(['wallet', 'mobile']));
    expect(problem('destination', answers({ method: 'mobile', destination: '0801' }), flow)).toBe(
      'destination.mobile.invalid',
    );
    expect(
      problem('destination', answers({ method: 'mobile', destination: '+254712345678' }), flow),
    ).toBeUndefined();
  });

  it('sends a person back to the method step when none is chosen', () => {
    expect(problem('destination', answers({ method: '' }))).toBe('method.missing');
  });

  it('has nothing to check on the review and confirmation screens', () => {
    expect(problem('review', answers())).toBeUndefined();
    expect(problem('done', answers())).toBeUndefined();
  });
});

describe('the connected flow', () => {
  it('skips the name, which UJIRA already holds, and ends with the wallet', () => {
    expect(CONNECTED_STEPS).toEqual(['method', 'destination', 'review', 'prove']);
    expect(firstStep(CONNECTED)).toBe('method');
    expect(nextStep('review', CONNECTED)).toBe('prove');
    expect(nextStep('prove', CONNECTED)).toBe('done');
    expect(stepCount(CONNECTED)).toBe(4);
    expect(stepNumber('method', CONNECTED)).toBe(1);
  });

  it('counts activation as part of proving, so the count never jumps', () => {
    expect(isQuestionStep('activate', CONNECTED)).toBe(true);
    expect(stepNumber('activate', CONNECTED)).toBe(stepNumber('prove', CONNECTED));
  });

  it('has no way back once the answers are saved', () => {
    expect(previousStep('prove', CONNECTED)).toBeUndefined();
    expect(previousStep('activate', CONNECTED)).toBeUndefined();
    expect(previousStep('method', CONNECTED)).toBeUndefined();
    expect(previousStep('review', CONNECTED)).toBe('destination');
  });

  it('offers only what the corridor pays out and the widget has finished', () => {
    const ids = (flow: Flow): string[] => offered(flow).map((method) => method.id);
    expect(ids(CONNECTED)).toEqual(['wallet']);
    // A signed mobile money partner in the corridor does not open a path the
    // widget has not finished.
    expect(ids({ ...CONNECTED, corridor: ['stellar_wallet', 'mobile_money'] })).toEqual(['wallet']);
    // Once it has, the corridor decides.
    const mobileOpen = { ...CONNECTED, methods: withOpen(['wallet', 'mobile']) };
    expect(ids({ ...mobileOpen, corridor: ['stellar_wallet'] })).toEqual(['wallet']);
    expect(ids({ ...mobileOpen, corridor: ['stellar_wallet', 'mobile_money'] })).toEqual([
      'wallet',
      'mobile',
    ]);
    expect(ids({ ...CONNECTED, corridor: [] })).toEqual([]);
  });

  it('refuses a method the corridor does not pay out', () => {
    const flow = { ...CONNECTED, corridor: [] };
    expect(problem('method', answers(), flow)).toBe('method.missing');
    expect(problem('destination', answers(), flow)).toBe('method.missing');
  });

  it('refuses an address a payout can never reach', () => {
    expect(problem('destination', answers({ destination: ISSUER }), CONNECTED)).toBe(
      'destination.wallet.unpayable',
    );
    expect(problem('destination', answers({ destination: ISSUER }))).toBeUndefined();
  });
});

describe('the connected flow with an identity check', () => {
  const VERIFYING: Flow = { ...CONNECTED, verify: true };

  it('puts the check straight after the choice, before any destination is saved', () => {
    expect(VERIFIED_STEPS).toEqual(['method', 'verify', 'destination', 'review', 'prove']);
    expect(nextStep('method', VERIFYING)).toBe('verify');
    expect(nextStep('verify', VERIFYING)).toBe('destination');
    expect(stepCount(VERIFYING)).toBe(5);
    expect(stepNumber('prove', VERIFYING)).toBe(5);
  });

  it('goes back past the check, which is not an answer a person changes', () => {
    expect(previousStep('destination', VERIFYING)).toBe('method');
    expect(previousStep('verify', VERIFYING)).toBe('method');
  });

  it('has no check without one to do', () => {
    expect(nextStep('method', CONNECTED)).toBe('destination');
    expect(isQuestionStep('verify', CONNECTED)).toBe(false);
  });
});
