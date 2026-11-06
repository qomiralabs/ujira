// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Task } from 'graphile-worker';

import type { WorkerHandlers } from '../worker/start.js';
import { CANCEL_LAPSED, RELEASE_HELD, SYSTEM_TASKS } from '../worker/tasks.js';
import { advanceWork } from './advance.js';
import { batchWork } from './batch.js';
import { cancelLapsedWork, sweepLapsed } from './cancel.js';
import type { EngineDeps } from './plan.js';
import { releaseWork, sweepHolds } from './release.js';

// The sweep is a safety net for a deposit that was missed, so ten minutes is the most a
// missed one waits.
const RELEASE_SWEEP_CRON = `*/10 * * * * ${SYSTEM_TASKS.releaseSweep}`;

// A lapsed payout holds its funds until this runs, and its record stays live for far longer
// than this, so a missed run costs a retry ten minutes and nothing else.
const LAPSED_SWEEP_CRON = `*/10 * * * * ${SYSTEM_TASKS.lapsedSweep}`;

// What a worker process needs to run the engine.
export function engineHandlers(
  deps: EngineDeps,
): Required<
  Pick<WorkerHandlers, 'payoutAdvance' | 'batchAdvance' | 'tenantTasks' | 'plugins' | 'crontab'>
> {
  const sweep: Task = async () => {
    await sweepHolds(deps.db);
  };
  return {
    payoutAdvance: advanceWork(deps),
    batchAdvance: batchWork(deps),
    tenantTasks: [
      { task: RELEASE_HELD, work: releaseWork(deps) },
      { task: CANCEL_LAPSED, work: cancelLapsedWork(deps) },
    ],
    plugins: {
      [SYSTEM_TASKS.releaseSweep]: sweep,
      [SYSTEM_TASKS.lapsedSweep]: async () => {
        await sweepLapsed(deps.db);
      },
    },
    crontab: [RELEASE_SWEEP_CRON, LAPSED_SWEEP_CRON],
  };
}

export { advanceWork, enqueueAdvance, ENGINE_TIMING } from './advance.js';
export { batchComplete, batchWork, enqueueBatchAdvance } from './batch.js';
export { cancelLapsedWork, sweepLapsed } from './cancel.js';
export { packExecutes, packRequests, transfersOf } from './pack.js';
export { onChainPayoutId, legKeyOf, taskRefOf } from './ids.js';
export { databaseDestinations, databaseMandates } from './routing.js';
export { enqueueRelease, releaseHeld, releaseWork, sweepHolds } from './release.js';
export type { AttestationRequest, EngineDeps, LegShare } from './plan.js';
export { databasePaidPayout } from './paid-payout.js';
