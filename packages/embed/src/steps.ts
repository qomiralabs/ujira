// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The step framework: one question per step, the order they come in, and the
// check that runs before a step is left. Pure functions, so the flow can be
// tested without a browser.

import type { MessageKey } from './i18n/catalogue.js';
import {
  methodById,
  openMethods,
  PAYOUT_METHODS,
  type MethodId,
  type PayoutMethod,
} from './methods.js';

/** Every screen, in order. The last one is the confirmation, not a question. */
export const STEP_IDS = ['name', 'method', 'destination', 'review', 'done'] as const;

export type StepId = (typeof STEP_IDS)[number];

/** The steps a person answers, which is what the progress line counts. */
export const QUESTION_STEPS = ['name', 'method', 'destination', 'review'] as const;

export type QuestionStep = (typeof QUESTION_STEPS)[number];

export interface Answers {
  name: string;
  /** Empty until a method is chosen, or when none is open. */
  method: MethodId | '';
  destination: string;
}

export function isQuestionStep(step: StepId): step is QuestionStep {
  return (QUESTION_STEPS as readonly StepId[]).includes(step);
}

/**
 * With one open method there is nothing to choose, so it is chosen already
 * and the step states it. With several, the person picks.
 */
export function initialAnswers(methods: readonly PayoutMethod[] = PAYOUT_METHODS): Answers {
  const open = openMethods(methods);
  const only = open.length === 1 ? open[0] : undefined;
  return { name: '', method: only?.id ?? '', destination: '' };
}

/** The 1 based position of a question step in the progress line. */
export function stepNumber(step: QuestionStep): number {
  return QUESTION_STEPS.indexOf(step) + 1;
}

export function stepCount(): number {
  return QUESTION_STEPS.length;
}

export function nextStep(step: StepId): StepId {
  const index = STEP_IDS.indexOf(step);
  return STEP_IDS[index + 1] ?? 'done';
}

export function previousStep(step: StepId): StepId | undefined {
  const index = STEP_IDS.indexOf(step);
  return index > 0 ? STEP_IDS[index - 1] : undefined;
}

const SHORT_LABELS: Readonly<Record<QuestionStep, MessageKey>> = {
  name: 'step.name.short',
  method: 'step.method.short',
  destination: 'step.destination.short',
  review: 'step.review.short',
};

/** Names the step in "Back to your name" and "Change your name". */
export function shortLabel(step: StepId): MessageKey | undefined {
  return isQuestionStep(step) ? SHORT_LABELS[step] : undefined;
}

/**
 * The problem with the current answer, as a copy key, or undefined when the
 * step is ready to be left.
 */
export function problem(
  step: StepId,
  answers: Answers,
  methods: readonly PayoutMethod[] = PAYOUT_METHODS,
): MessageKey | undefined {
  if (step === 'name') {
    return answers.name.trim() === '' ? 'name.missing' : undefined;
  }
  const method = methodById(answers.method, methods);
  if (step === 'method') {
    return method?.open === true ? undefined : 'method.missing';
  }
  if (step === 'destination') {
    if (method === undefined) return 'method.missing';
    const value = answers.destination.trim();
    if (value === '') return method.destination.missing;
    return method.destination.shape.test(value) ? undefined : method.destination.invalid;
  }
  return undefined;
}
