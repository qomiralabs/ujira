// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Compile time proofs: `tsc` fails if any line marked below stops being an error.

import type { JobSpec } from './repositories/jobs.js';

export const colon: JobSpec = { task: 'payout:advance', ids: { payoutId: 'p1' } };

export const everything: JobSpec = {
  task: 'payout:advance',
  ids: { payoutId: 'p1' },
  jobKey: 'payout:p1',
  queueName: 'mandate:m1',
  runAt: new Date(0),
  maxAttempts: 3,
  keyMode: 'preserve_run_at',
  scope: 'principal',
};

// @ts-expect-error a dotted task name is refused: the crontab parser rejects it
export const dotted: JobSpec = { task: 'payout.advance', ids: {} };

// @ts-expect-error a task name needs a colon
export const bare: JobSpec = { task: 'advance', ids: {} };

// @ts-expect-error tenant ids come from the transaction
export const withPrincipal: JobSpec = { task: 'payout:advance', ids: { principalId: 'x' } };

// @ts-expect-error tenant ids come from the transaction
export const withProject: JobSpec = { task: 'payout:advance', ids: { projectId: 'x' } };

// @ts-expect-error ids are strings
export const numeric: JobSpec = { task: 'payout:advance', ids: { payoutId: 1 } };

// @ts-expect-error dedupe can drop a state change, so it is not offered
export const dedupe: JobSpec = { task: 'a:b', ids: {}, keyMode: 'unsafe_dedupe' };
