// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Rechecking a principal's key rule from the queue rather than inline in the indexer,
// so rechecks for one principal take turns and a failed chain read gets the handler's
// bounded retries and, in the end, a dead letter that someone hears about. A recheck
// stuck there leaves a mandate's state stale, so it must not fail quietly.

import type { Uuid } from '@ujira/chain-adapter';
import type { TenantTx } from '@ujira/db';
import {
  PolicyStoreError,
  PolicyStoreTimeoutError,
  WATCHED_MANDATE_EVENTS,
  recheckPrincipal,
  type ComplianceDeps,
} from '@ujira/mandates';

import { RetryableJobError } from './errors.js';
import type { TenantWork } from './handlers.js';
import { COMPLIANCE_RECHECK, enqueueTask } from './tasks.js';

export const COMPLIANCE_TIMEOUT = 'COMPLIANCE_TIMEOUT';
export const COMPLIANCE_READ_FAILED = 'COMPLIANCE_READ_FAILED';

// Called in the transaction that books a mandate event, so the recheck exists only if
// the event does. The job carries no reading: it reads the holdings when it runs, which
// is what lets a waiting job stand for every event that came after it. Returns the
// job's id, or null for an event that cannot change the answer.
export async function scheduleRecheck(tx: TenantTx, eventName: string): Promise<bigint | null> {
  if (!WATCHED_MANDATE_EVENTS.has(eventName)) return null;
  return enqueueTask(tx, COMPLIANCE_RECHECK, {});
}

// The principal comes from the job's tenant, never its payload, so one principal's
// recheck cannot read or mark another's holdings.
export function complianceRecheck(deps: ComplianceDeps): TenantWork {
  return async (job) => {
    try {
      await recheckPrincipal(job.context.principalId as Uuid, deps);
    } catch (error) {
      // A failed read changes nothing before it throws, so trying again is safe.
      if (error instanceof PolicyStoreTimeoutError) {
        throw new RetryableJobError(COMPLIANCE_TIMEOUT, { cause: error });
      }
      if (error instanceof PolicyStoreError) {
        throw new RetryableJobError(COMPLIANCE_READ_FAILED, { cause: error });
      }
      throw error;
    }
  };
}
