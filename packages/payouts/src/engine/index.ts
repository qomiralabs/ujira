// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { Task } from 'graphile-worker';

import type { WorkerHandlers } from '../worker/start.js';
import { RELEASE_HELD, SYSTEM_TASKS } from '../worker/tasks.js';
import { advanceWork } from './advance.js';
import type { EngineDeps } from './plan.js';
import { releaseWork, sweepHolds } from './release.js';

// The sweep is a safety net for a deposit that was missed, so ten minutes is the most a
// missed one waits.
const RELEASE_SWEEP_CRON = `*/10 * * * * ${SYSTEM_TASKS.releaseSweep}`;

// What a worker process needs to run the engine.
export function engineHandlers(
  deps: EngineDeps,
): Required<Pick<WorkerHandlers, 'payoutAdvance' | 'tenantTasks' | 'plugins' | 'crontab'>> {
  const sweep: Task = async () => {
    await sweepHolds(deps.db);
  };
  return {
    payoutAdvance: advanceWork(deps),
    tenantTasks: [{ task: RELEASE_HELD, work: releaseWork(deps) }],
    plugins: { [SYSTEM_TASKS.releaseSweep]: sweep },
    crontab: [RELEASE_SWEEP_CRON],
  };
}

export { advanceWork, enqueueAdvance, ENGINE_TIMING } from './advance.js';
export { onChainPayoutId, legKeyOf, taskRefOf } from './ids.js';
export { databaseDestinations, databaseMandates } from './routing.js';
export { enqueueRelease, releaseHeld, releaseWork, sweepHolds } from './release.js';
export type { AttestationRequest, EngineDeps, LegShare } from './plan.js';
