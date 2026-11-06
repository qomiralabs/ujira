// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The step framework: one question per step, the order they come in, and the
// check that runs before a step is left. Pure functions, so the flow can be
// tested without a browser.
//
// There are two flows. Handed answers: the page saves them itself, so the
// widget asks for the name too and stops at the review. Connected: the
// widget saves through UJIRA with the page's embed token, the person is
// already registered by name, and after the review their wallet confirms the
// address is theirs. Activation is a detour inside that last step, not a
// step of its own, so it never changes the count a person was shown.

import type { ApiMethod } from './api/contract.js';
import { readWalletDestination } from './destination.js';
import type { MessageKey } from './i18n/catalogue.js';
import {
  methodById,
  openMethods,
  PAYOUT_METHODS,
  type MethodId,
  type PayoutMethod,
} from './methods.js';

/** Every screen. The last one is the confirmation, not a question. */
export const STEP_IDS = [
  'name',
  'method',
  'verify',
  'destination',
  'review',
  'prove',
  'activate',
  'done',
] as const;

export type StepId = (typeof STEP_IDS)[number];

/** The questions of the handed answers flow, in order. */
export const QUESTION_STEPS = ['name', 'method', 'destination', 'review'] as const;

/** The questions of the connected flow, in order. */
export const CONNECTED_STEPS = ['method', 'destination', 'review', 'prove'] as const;

/**
 * The connected flow when the chosen method needs an identity check first:
 * it comes straight after the choice, before any destination is saved.
 */
export const VERIFIED_STEPS = ['method', 'verify', 'destination', 'review', 'prove'] as const;

export type QuestionStep =
  | (typeof QUESTION_STEPS)[number]
  | (typeof CONNECTED_STEPS)[number]
  | (typeof VERIFIED_STEPS)[number];

export interface Answers {
  name: string;
  /** Empty until a method is chosen, or when none is offered. */
  method: MethodId | '';
  destination: string;
  /** A numeric memo for a wallet destination, or empty. */
  memo: string;
}

/** What the steps need to know about where they run. */
export interface Flow {
  connected: boolean;
  methods: readonly PayoutMethod[];
  /** The corridor's methods from the session, when there is one. */
  corridor?: readonly ApiMethod[];
  /** Addresses a payout can never reach, from the session. */
  neverPayable: readonly string[];
  /**
   * The chosen method needed an identity check when the session started.
   * It stays true once the check passes, so the count a person was shown
   * never shrinks under them.
   */
  verify?: boolean;
}

export const HANDED: Flow = { connected: false, methods: PAYOUT_METHODS, neverPayable: [] };

function questions(flow: Flow): readonly StepId[] {
  if (!flow.connected) return QUESTION_STEPS;
  return flow.verify === true ? VERIFIED_STEPS : CONNECTED_STEPS;
}

export function firstStep(flow: Flow = HANDED): StepId {
  return questions(flow)[0] ?? 'done';
}

/** A step with a place in the progress line; activation shares proving's. */
export function isQuestionStep(step: StepId, flow: Flow = HANDED): boolean {
  return questions(flow).includes(step === 'activate' ? 'prove' : step);
}

/** The methods this flow offers. */
export function offered(flow: Flow = HANDED): readonly PayoutMethod[] {
  return openMethods(flow.methods, flow.corridor);
}

/**
 * With one method offered there is nothing to choose, so it is chosen
 * already and the step states it. With several, the person picks.
 */
export function initialAnswers(flow: Flow = HANDED): Answers {
  const open = offered(flow);
  const only = open.length === 1 ? open[0] : undefined;
  return { name: '', method: only?.id ?? '', destination: '', memo: '' };
}

/** The 1 based position of a step in the progress line. */
export function stepNumber(step: StepId, flow: Flow = HANDED): number {
  return questions(flow).indexOf(step === 'activate' ? 'prove' : step) + 1;
}

export function stepCount(flow: Flow = HANDED): number {
  return questions(flow).length;
}

export function nextStep(step: StepId, flow: Flow = HANDED): StepId {
  const order = questions(flow);
  const index = order.indexOf(step);
  return index < 0 ? 'done' : (order[index + 1] ?? 'done');
}

/**
 * Where Back goes. Nowhere once the answers are saved: they cannot be
 * unsaved. And past the identity check rather than into it, since a check
 * is not an answer a person changes.
 */
export function previousStep(step: StepId, flow: Flow = HANDED): StepId | undefined {
  if (step === 'prove' || step === 'activate') return undefined;
  const order = questions(flow).filter((id) => id !== 'verify' || step === 'verify');
  const index = order.indexOf(step);
  return index > 0 ? order[index - 1] : undefined;
}

const SHORT_LABELS: Readonly<Partial<Record<StepId, MessageKey>>> = {
  name: 'step.name.short',
  method: 'step.method.short',
  destination: 'step.destination.short',
  review: 'step.review.short',
};

/** Names the step in "Back to your name" and "Change your name". */
export function shortLabel(step: StepId): MessageKey | undefined {
  return SHORT_LABELS[step];
}

/** A problem with an answer, and the field it belongs to. */
export interface AnswerProblem {
  key: MessageKey;
  field: 'answer' | 'memo';
}

/**
 * The problem with the current answer, or undefined when the step is ready
 * to be left. The wallet address is read in full, with the server's rules;
 * the server reads it again and has the last word.
 */
export function findProblem(
  step: StepId,
  answers: Answers,
  flow: Flow = HANDED,
): AnswerProblem | undefined {
  const answer = (key: MessageKey): AnswerProblem => ({ key, field: 'answer' });
  if (step === 'name') {
    return answers.name.trim() === '' ? answer('name.missing') : undefined;
  }
  const method = methodById(answers.method, flow.methods);
  const isOffered = method !== undefined && offered(flow).includes(method);
  if (step === 'method') {
    return isOffered ? undefined : answer('method.missing');
  }
  if (step === 'destination') {
    if (method === undefined || !isOffered) return answer('method.missing');
    if (method.id === 'wallet') {
      const read = readWalletDestination(answers.destination, answers.memo, flow.neverPayable);
      return read.ok
        ? undefined
        : { key: read.problem, field: read.field === 'memo' ? 'memo' : 'answer' };
    }
    const value = answers.destination.trim();
    if (value === '') return answer(method.destination.missing);
    const shape = method.destination.shape;
    return shape === undefined || shape.test(value)
      ? undefined
      : answer(method.destination.invalid);
  }
  return undefined;
}

/** Only the words of the problem, for callers that need nothing else. */
export function problem(
  step: StepId,
  answers: Answers,
  flow: Flow = HANDED,
): MessageKey | undefined {
  return findProblem(step, answers, flow)?.key;
}
