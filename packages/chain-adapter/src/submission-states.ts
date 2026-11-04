// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// How a submission's state may move. The database enforces the same table with
// a constraint, so a move it does not allow fails there, at the worst moment:
// while recording that a send went wrong. Adapters read it from here so they
// never attempt one.

import type { SubmissionState } from './types.js';

/** States in which a submission can still land, and so blocks another. */
export const LIVE_SUBMISSION_STATES: readonly SubmissionState[] = Object.freeze([
  'built',
  'broadcast',
  'unknown',
]);

/** Every move a submission may make. Anything else is backward or sideways. */
export const SUBMISSION_TRANSITIONS: Readonly<Record<SubmissionState, readonly SubmissionState[]>> =
  Object.freeze({
    built: ['broadcast'],
    broadcast: ['landed', 'failed', 'unknown', 'expired', 'replaced'],
    unknown: ['landed', 'failed', 'expired'],
    landed: [],
    failed: [],
    expired: [],
    replaced: [],
  });

export function isLiveSubmission(state: SubmissionState): boolean {
  return LIVE_SUBMISSION_STATES.includes(state);
}

export function canMoveSubmission(from: SubmissionState, to: SubmissionState): boolean {
  return SUBMISSION_TRANSITIONS[from].includes(to);
}
