// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { PAYOUT_METHODS, type PayoutMethod } from './methods.js';
import {
  initialAnswers,
  isQuestionStep,
  nextStep,
  previousStep,
  problem,
  QUESTION_STEPS,
  shortLabel,
  stepCount,
  stepNumber,
  STEP_IDS,
  type Answers,
} from './steps.js';

const WALLET = `G${'A'.repeat(55)}`;

function withOpen(ids: readonly string[]): readonly PayoutMethod[] {
  return PAYOUT_METHODS.map((method) => ({ ...method, open: ids.includes(method.id) }));
}

function answers(fields: Partial<Answers> = {}): Answers {
  return { name: 'Amara Eze', method: 'wallet', destination: WALLET, ...fields };
}

describe('step framework', () => {
  it('counts only the steps a person answers', () => {
    expect(STEP_IDS).toEqual(['name', 'method', 'destination', 'review', 'done']);
    expect(QUESTION_STEPS).toEqual(['name', 'method', 'destination', 'review']);
    expect(stepCount()).toBe(4);
    expect(stepNumber('destination')).toBe(3);
    expect(isQuestionStep('done')).toBe(false);
  });

  it('moves forward and back, and stops at the ends', () => {
    expect(nextStep('name')).toBe('method');
    expect(nextStep('review')).toBe('done');
    expect(nextStep('done')).toBe('done');
    expect(previousStep('method')).toBe('name');
    expect(previousStep('name')).toBeUndefined();
  });

  it('names a step for the back and change controls', () => {
    expect(shortLabel('name')).toBe('step.name.short');
    expect(shortLabel('done')).toBeUndefined();
  });

  it('chooses the only open method for the person', () => {
    expect(initialAnswers()).toEqual({ name: '', method: 'wallet', destination: '' });
  });

  it('leaves the method unchosen when several are open', () => {
    expect(initialAnswers(withOpen(['wallet', 'bank'])).method).toBe('');
  });

  it('leaves the method unchosen when none is open', () => {
    expect(initialAnswers(withOpen([])).method).toBe('');
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

  it('says what is wrong with an address that is the wrong shape', () => {
    expect(problem('destination', answers({ destination: 'GABC' }))).toBe(
      'destination.wallet.invalid',
    );
    expect(problem('destination', answers({ destination: ` ${WALLET} ` }))).toBeUndefined();
  });

  it('sends a person back to the method step when none is chosen', () => {
    expect(problem('destination', answers({ method: '' }))).toBe('method.missing');
  });

  it('has nothing to check on the review and confirmation screens', () => {
    expect(problem('review', answers())).toBeUndefined();
    expect(problem('done', answers())).toBeUndefined();
  });
});
