// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A mandate instance UJIRA stops serving until it complies again, the jobs parked on it,
// and the notices owed to its principal. Marking and parking take the same lock on the
// instance, so a job can never be parked just after the mark cleared with nothing left to
// resume it. The lock is an advisory one on the instance: it needs no rights on any row,
// and two tenants whose keys happen to collide only wait for each other.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export type ComplianceReason = 'principal_key_risk';
export type ComplianceTransition = 'noncompliant' | 'compliant';

export interface ComplianceMarkRow {
  readonly instanceId: string;
  readonly reason: ComplianceReason;
  readonly since: Date;
}

export interface NewComplianceNotice {
  readonly to: ComplianceTransition;
  readonly at: Date;
  readonly fixes: readonly string[];
}

export interface ComplianceNoticeRow extends NewComplianceNotice {
  readonly id: string;
  readonly instanceId: string;
  readonly createdAt: Date;
}

export type ComplianceCloseReason = 'mandate_revoked' | 'mandate_expired';

export interface ParkedJob {
  readonly instanceId: string;
  readonly jobId: string;
  readonly status: 'parked' | 'resumed' | 'closed';
  readonly parkedAt: Date;
  readonly resumedAt: Date | null;
  readonly closedAt: Date | null;
  readonly closeReason: ComplianceCloseReason | null;
}

async function lockInstance(db: Tx, instanceId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`compliance:${instanceId}`}, 0))`.execute(
    db,
  );
}

async function markOf(db: Tx, instanceId: string): Promise<ComplianceMarkRow | undefined> {
  const row = await db
    .selectFrom('ujira.compliance_marks')
    .select(['mandate_instance_id', 'reason', 'since'])
    .where('mandate_instance_id', '=', instanceId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    instanceId: row.mandate_instance_id,
    reason: row.reason as ComplianceReason,
    since: row.since,
  };
}

export const compliance = {
  mark: async (db: Tx, instanceId: string): Promise<ComplianceMarkRow | undefined> =>
    markOf(db, instanceId),

  // The caller's transaction holds all of it: the mark, the notice and, on a clear, the
  // resume. Nothing changes, and no notice is written, when the mark is already as asked,
  // so a replayed event is a no op.
  applyMark: async (
    db: Tx,
    instanceId: string,
    mark: { readonly reason: ComplianceReason; readonly since: Date } | null,
    notice: NewComplianceNotice,
  ): Promise<boolean> => {
    await lockInstance(db, instanceId);
    const current = await markOf(db, instanceId);
    if ((current !== undefined) === (mark !== null)) return false;
    if (mark === null) {
      await db
        .deleteFrom('ujira.compliance_marks')
        .where('mandate_instance_id', '=', instanceId)
        .execute();
      await db
        .updateTable('ujira.compliance_parked_jobs')
        .set({ status: 'resumed', resumed_at: sql<Date>`now()` })
        .where('mandate_instance_id', '=', instanceId)
        .where('status', '=', 'parked')
        .execute();
    } else {
      await db
        .insertInto('ujira.compliance_marks')
        .values({
          principal_id: CURRENT_PRINCIPAL,
          project_id: CURRENT_PROJECT,
          mandate_instance_id: instanceId,
          reason: mark.reason,
          since: mark.since,
        })
        .execute();
    }
    await db
      .insertInto('ujira.compliance_notices')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_instance_id: instanceId,
        transition: notice.to,
        noticed_at: notice.at,
        fixes: JSON.stringify(notice.fixes),
      })
      .execute();
    return true;
  },

  // Under the same lock as the mark. Parking a job again keeps its one row, parked again.
  parkIfNoncompliant: async (db: Tx, instanceId: string, jobId: string): Promise<boolean> => {
    await lockInstance(db, instanceId);
    if ((await markOf(db, instanceId)) === undefined) return false;
    await db
      .insertInto('ujira.compliance_parked_jobs')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_instance_id: instanceId,
        job_id: jobId,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['principal_id', 'project_id', 'mandate_instance_id', 'job_id'])
          .doUpdateSet({
            status: 'parked',
            parked_at: sql<Date>`now()`,
            resumed_at: null,
            closed_at: null,
            close_reason: null,
          }),
      )
      .execute();
    return true;
  },

  // Under the same lock as the mark, so a job is parked before this and closed by it, or
  // finds no mark after it and is not parked. The mark goes with no notice: the mandate
  // stopped, it did not become compliant. In job order, so a replay reads the same.
  closeOut: async (
    db: Tx,
    instanceId: string,
    reason: ComplianceCloseReason,
  ): Promise<readonly string[]> => {
    await lockInstance(db, instanceId);
    await db
      .deleteFrom('ujira.compliance_marks')
      .where('mandate_instance_id', '=', instanceId)
      .execute();
    const rows = await db
      .updateTable('ujira.compliance_parked_jobs')
      .set({ status: 'closed', closed_at: sql<Date>`now()`, close_reason: reason })
      .where('mandate_instance_id', '=', instanceId)
      .where('status', '=', 'parked')
      .returning('job_id')
      .execute();
    return rows.map((row) => row.job_id).sort();
  },

  parkedJobs: async (db: Tx, instanceId: string): Promise<readonly ParkedJob[]> => {
    const rows = await db
      .selectFrom('ujira.compliance_parked_jobs')
      .select([
        'mandate_instance_id',
        'job_id',
        'status',
        'parked_at',
        'resumed_at',
        'closed_at',
        'close_reason',
      ])
      .where('mandate_instance_id', '=', instanceId)
      .orderBy('parked_at')
      .orderBy('job_id')
      .execute();
    return rows.map((row) => ({
      instanceId: row.mandate_instance_id,
      jobId: row.job_id,
      status: row.status as ParkedJob['status'],
      parkedAt: row.parked_at,
      resumedAt: row.resumed_at,
      closedAt: row.closed_at,
      closeReason: row.close_reason as ComplianceCloseReason | null,
    }));
  },

  notices: async (db: Tx, instanceId: string): Promise<readonly ComplianceNoticeRow[]> => {
    const rows = await db
      .selectFrom('ujira.compliance_notices')
      .select(['id', 'mandate_instance_id', 'transition', 'noticed_at', 'fixes', 'created_at'])
      .where('mandate_instance_id', '=', instanceId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      instanceId: row.mandate_instance_id,
      to: row.transition as ComplianceTransition,
      at: row.noticed_at,
      fixes: row.fixes as string[],
      createdAt: row.created_at,
    }));
  },
};

export const complianceRepositories = { compliance };
