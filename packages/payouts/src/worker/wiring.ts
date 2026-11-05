// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Everything the worker runs, from the parts it is built of. The same function serves a
// deployment and the test that drives a payout from request to receipt, so what the test
// proves is what runs.
//
// A deployment cannot build these parts yet, because some of the stores under them are
// not merged. productionParts says which, by issue, and the process refuses to start
// rather than run with something standing in for one.

import type { ComplianceDeps } from '@ujira/mandates';
import { RECEIPT_ISSUE_TASK, receiptIssueTask, type ReceiptIssuePorts } from '@ujira/receipts';
import type { Task } from 'graphile-worker';

import { engineHandlers } from '../engine/index.js';
import type { EngineDeps } from '../engine/plan.js';
import { complianceRecheck } from './compliance-recheck.js';
import type { NetworkScan, SubmissionSweeper } from './crons.js';
import { WorkerConfigError } from './errors.js';
import type { WorkerHandlers } from './start.js';
import { COMPLIANCE_RECHECK } from './tasks.js';

export interface WorkerParts {
  readonly engine: EngineDeps;
  readonly receipts: ReceiptIssuePorts;
  readonly compliance: ComplianceDeps;
  readonly indexerScans: readonly NetworkScan[];
  readonly submissionSweepers: readonly SubmissionSweeper[];
  readonly ttlKeepAlive: NonNullable<WorkerHandlers['ttlKeepAlive']>;
}

export function workerHandlers(parts: WorkerParts): WorkerHandlers {
  const engine = engineHandlers(parts.engine);
  const issue = receiptIssueTask(parts.receipts);
  // Keeps its own retries, so a receipt the chain has not confirmed yet waits for it.
  const receipt: Task = async (payload, helpers) => {
    await issue(payload, { correlationId: `${RECEIPT_ISSUE_TASK}:${helpers.job.id}` });
  };
  return {
    ...engine,
    tenantTasks: [
      ...engine.tenantTasks,
      { task: COMPLIANCE_RECHECK, work: complianceRecheck(parts.compliance) },
    ],
    plugins: { ...engine.plugins, [RECEIPT_ISSUE_TASK]: receipt },
    indexerScans: parts.indexerScans,
    submissionSweepers: parts.submissionSweepers,
    ttlKeepAlive: parts.ttlKeepAlive,
  };
}

// What a deployment still lacks, each with the issue that builds it. An entry goes when
// its store merges and the part it feeds is built here.
export const MISSING_STORES: readonly { readonly name: string; readonly issue: number }[] = [
  { name: "the chain adapter's store", issue: 591 },
  { name: 'the store for Stellar signing requests', issue: 377 },
  { name: 'the compliance store', issue: 423 },
  { name: 'the identity store, for verified destinations', issue: 370 },
  { name: 'the receipts table', issue: 64 },
];

export class WorkerStoresMissingError extends WorkerConfigError {
  readonly missing: readonly { readonly name: string; readonly issue: number }[];

  constructor(missing: readonly { readonly name: string; readonly issue: number }[]) {
    super(
      `the worker cannot start without ${missing
        .map(({ name, issue }) => `${name} (#${String(issue)})`)
        .join(', ')}`,
    );
    this.missing = missing;
  }
}

// The parts a deployment runs on. Refuses while any store under them is missing, so
// nothing in a production path stands in for one.
export function productionParts(): WorkerParts {
  if (MISSING_STORES.length > 0) throw new WorkerStoresMissingError(MISSING_STORES);
  throw new WorkerConfigError('the worker parts are not built');
}
