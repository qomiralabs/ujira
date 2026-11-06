// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Each mandate instance's ledger mirror compared with the contract's state(). The
// contract is the authority: a comparison stores what state() said, reads the books
// beside it through the reconciliation view, and records the outcome on the instance.
// It never writes a journal, so a disagreement is shown, not corrected.

import { sql, type Kysely, type Selectable } from 'kysely';

import type { Schema, UjiraInstanceReconciliations } from '../schema.generated.js';
import { ledger, type MandateState } from './ledger.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

export interface ReconcileFigures {
  readonly balance: bigint;
  readonly pending: bigint;
  readonly committed: bigint;
  readonly spent: bigint;
}

export interface InstanceReconciliation {
  readonly mandateInstanceId: string;
  /** The ledger the comparison read state() at. */
  readonly ledger: bigint;
  readonly matches: boolean;
  readonly checkedAt: Date;
  /** When the books last agreed with the contract, or null if they never have. */
  readonly lastReconciledAt: Date | null;
  /** Since when they disagree, or null while they agree. */
  readonly divergedSince: Date | null;
}

export interface ReconciliationResult extends InstanceReconciliation {
  readonly state: ReconcileFigures;
  readonly books: ReconcileFigures;
  /** True only on the comparison that found them apart after they last agreed. */
  readonly newlyDiverged: boolean;
}

/** state() could not be set beside the books: the instance is not this tenant's. */
export class ReconciliationNotVisibleError extends Error {
  override readonly name = 'ReconciliationNotVisibleError';
  constructor() {
    super('no reconciliation is visible for this instance');
  }
}

const columns = [
  'mandate_instance_id',
  'ledger',
  'matches',
  'checked_at',
  'last_reconciled_at',
  'diverged_since',
] as const;

type Row = Pick<Selectable<UjiraInstanceReconciliations>, (typeof columns)[number]>;

function toReconciliation(row: Row): InstanceReconciliation {
  return {
    mandateInstanceId: row.mandate_instance_id,
    ledger: BigInt(row.ledger),
    matches: row.matches,
    checkedAt: row.checked_at,
    lastReconciledAt: row.last_reconciled_at,
    divergedSince: row.diverged_since,
  };
}

async function current(
  db: Tx,
  mandateInstanceId: string,
): Promise<InstanceReconciliation | undefined> {
  const row = await db
    .selectFrom('ujira.instance_reconciliations')
    .select(columns)
    .where('mandate_instance_id', '=', mandateInstanceId)
    .executeTakeFirst();
  return row === undefined ? undefined : toReconciliation(row);
}

export const reconciliations = {
  // Compares state() at a ledger with the books, in the current transaction, and
  // records the outcome. The time it last agreed survives a disagreement, and the
  // time a disagreement began survives until it ends.
  record: async (db: Tx, state: MandateState): Promise<ReconciliationResult> => {
    await ledger.recordState(db, state);
    const compared = await ledger.reconciliation(db, state.mandateInstanceId);
    if (compared === undefined) throw new ReconciliationNotVisibleError();
    const before = await current(db, state.mandateInstanceId);
    const now = new Date();
    const matches = compared.matches;
    const lastReconciledAt = matches ? now : (before?.lastReconciledAt ?? null);
    const divergedSince = matches ? null : (before?.divergedSince ?? now);
    const values = {
      ledger: compared.ledger,
      matches,
      checked_at: now,
      last_reconciled_at: lastReconciledAt,
      diverged_since: divergedSince,
    };
    const row = await db
      .insertInto('ujira.instance_reconciliations')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_instance_id: state.mandateInstanceId,
        ...values,
      })
      .onConflict((conflict) =>
        conflict.columns(['principal_id', 'project_id', 'mandate_instance_id']).doUpdateSet(values),
      )
      .returning(columns)
      .executeTakeFirstOrThrow();
    return {
      ...toReconciliation(row),
      state: compared.state,
      books: compared.books,
      newlyDiverged: !matches && (before === undefined || before.matches),
    };
  },

  // The latest outcome for one instance, or undefined when none is visible here.
  get: current,
};

export const reconciliationRepositories = { reconciliations } as const;
