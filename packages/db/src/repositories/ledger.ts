// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The ledger mirror. A journal records one finalized chain event as signed
// entries that sum to zero; the database refuses anything else at commit, and
// ledger_stamp writes each entry's sequence and running balance. A correction
// is a reversal journal, never an edit.
//
// Amounts are bigint throughout, signed, in the raw units of the instance's
// asset. They cross to the database as decimal text.

import type { TokenAmount } from '@ujira/core';
import { sql, type Kysely } from 'kysely';

import { tokenFromRow } from '../money-mapper.js';
import type { Schema } from '../schema.generated.js';
import { checkedLimit, pageOf, PageRequestError, type Page, type PageRequest } from './page.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

// balance, pending, committed and spent are the figures the contract reports.
// external is the other side of money entering or leaving it.
export type LedgerAccountKind = 'balance' | 'pending' | 'committed' | 'spent' | 'external';

export interface LedgerAccount {
  readonly id: string;
  readonly kind: LedgerAccountKind;
  readonly balance: TokenAmount;
  readonly lastSeq: bigint;
}

export interface LedgerEntryInput {
  readonly kind: LedgerAccountKind;
  // Signed, in raw units. Must not be zero.
  readonly amount: bigint;
}

export interface LedgerEntry {
  readonly id: string;
  readonly journalId: string;
  readonly accountId: string;
  readonly amount: bigint;
  readonly accountSeq: bigint;
  readonly balanceAfter: bigint;
}

export interface PostResult {
  // False when this event was already posted, and nothing changed.
  readonly created: boolean;
  readonly journalId: string | undefined;
}

export interface MandateState {
  readonly mandateInstanceId: string;
  readonly ledger: bigint;
  readonly balance: bigint;
  readonly pending: bigint;
  readonly committed: bigint;
  readonly spent: bigint;
}

export interface Reconciliation {
  readonly mandateInstanceId: string;
  readonly ledger: bigint;
  readonly state: Omit<MandateState, 'mandateInstanceId' | 'ledger'>;
  readonly books: Omit<MandateState, 'mandateInstanceId' | 'ledger'>;
  // False is a disagreement between the ledger and the contract.
  readonly matches: boolean;
}

const KINDS: readonly LedgerAccountKind[] = [
  'balance',
  'pending',
  'committed',
  'spent',
  'external',
];

function accountKind(value: string): LedgerAccountKind {
  const found = KINDS.find((kind) => kind === value);
  // The column's check makes this unreachable unless the two lists drift.
  if (found === undefined) throw new Error('a ledger account holds a kind this code does not know');
  return found;
}

const entryColumns = [
  'id',
  'journal_id',
  'account_id',
  'amount',
  'account_seq',
  'balance_after',
] as const;

function toEntry(row: {
  id: string;
  journal_id: string;
  account_id: string;
  amount: string;
  account_seq: string;
  balance_after: string;
}): LedgerEntry {
  return {
    id: row.id,
    journalId: row.journal_id,
    accountId: row.account_id,
    amount: BigInt(row.amount),
    accountSeq: BigInt(row.account_seq),
    balanceAfter: BigInt(row.balance_after),
  };
}

// Writes the entries of a journal. Accounts are taken in id order, whatever
// order the caller listed them in: ledger_stamp locks each account row, so two
// journals taking the same accounts in opposite orders would deadlock.
async function writeEntries(
  db: Tx,
  journalId: string,
  mandateInstanceId: string,
  entries: readonly LedgerEntryInput[],
): Promise<void> {
  if (entries.length === 0) return;
  // Sorted and inserted in that order, so two journals opening the same accounts
  // at once take them the same way round: otherwise each can wait on a row the
  // other inserted and has not committed, and they deadlock.
  const kinds = [...new Set(entries.map((entry) => entry.kind))].sort();
  // Accounts open on first use, in the instance's own unit. An instance of
  // another tenant is not visible here, so nothing opens for it.
  await sql`
    insert into ujira.ledger_accounts
      (principal_id, project_id, mandate_instance_id, kind, chain, asset, scale)
    select i.principal_id, i.project_id, i.id, k.kind, i.chain, i.asset, i.scale
      from ujira.mandate_instances as i, unnest(${kinds}::text[]) with ordinality as k (kind, at)
     where i.id = ${mandateInstanceId}
     order by k.at
    on conflict on constraint ledger_accounts_per_kind do nothing
  `.execute(db);
  const accounts = await db
    .selectFrom('ujira.ledger_accounts')
    .select(['id', 'kind'])
    .where('mandate_instance_id', '=', mandateInstanceId)
    .where('kind', 'in', kinds)
    .execute();
  const idOf = new Map(accounts.map((account) => [account.kind, account.id]));
  const rows = entries
    .map((entry) => ({ entry, accountId: idOf.get(entry.kind) }))
    .sort((left, right) => ((left.accountId ?? '') < (right.accountId ?? '') ? -1 : 1));
  for (const { entry, accountId } of rows) {
    await db
      .insertInto('ujira.ledger_entries')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        journal_id: journalId,
        // A missing account fails the foreign key rather than being skipped,
        // so a journal can never quietly lose a side.
        account_id: accountId ?? mandateInstanceId,
        amount: entry.amount.toString(),
        // ledger_stamp overwrites both of these.
        account_seq: 0n,
        balance_after: '0',
      })
      .execute();
  }
}

const SEQ_KEY = /^\d{1,19}$/;

export const ledger = {
  // The accounts of one instance that have been used.
  accounts: async (db: Tx, mandateInstanceId: string): Promise<LedgerAccount[]> => {
    const rows = await db
      .selectFrom('ujira.ledger_accounts')
      .select(['id', 'kind', 'balance', 'last_seq', 'asset', 'chain', 'scale'])
      .where('mandate_instance_id', '=', mandateInstanceId)
      .orderBy('kind')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      kind: accountKind(row.kind),
      balance: tokenFromRow({
        amount: row.balance,
        asset: row.asset,
        chain: row.chain,
        scale: row.scale,
      }),
      lastSeq: BigInt(row.last_seq),
    }));
  },

  // Posts one chain event as one journal. Posting the same event again changes
  // nothing. Entries that do not sum to zero are refused at commit with UJ003,
  // and one that takes an account past zero the wrong way with UJ011.
  post: async (
    db: Tx,
    input: {
      readonly mandateInstanceId: string;
      readonly chainEventId: string;
      readonly entries: readonly LedgerEntryInput[];
    },
  ): Promise<PostResult> => {
    const inserted = await db
      .insertInto('ujira.ledger_journals')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_instance_id: input.mandateInstanceId,
        chain_event_id: input.chainEventId,
      })
      .onConflict((conflict) => conflict.constraint('ledger_journals_per_event').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted === undefined) {
      const existing = await db
        .selectFrom('ujira.ledger_journals')
        .select('id')
        .where('chain_event_id', '=', input.chainEventId)
        .executeTakeFirst();
      return { created: false, journalId: existing?.id };
    }
    await writeEntries(db, inserted.id, input.mandateInstanceId, input.entries);
    return { created: true, journalId: inserted.id };
  },

  // Reverses a journal with a new one of the opposite entries. A journal is
  // reversed at most once. Undefined when the journal is not visible here.
  reverse: async (db: Tx, journalId: string): Promise<PostResult | undefined> => {
    const journal = await db
      .selectFrom('ujira.ledger_journals')
      .select(['mandate_instance_id'])
      .where('id', '=', journalId)
      .executeTakeFirst();
    if (journal === undefined) return undefined;
    const inserted = await db
      .insertInto('ujira.ledger_journals')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_instance_id: journal.mandate_instance_id,
        reverses_journal_id: journalId,
      })
      .onConflict((conflict) => conflict.constraint('ledger_journals_reversed_once').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted === undefined) {
      const existing = await db
        .selectFrom('ujira.ledger_journals')
        .select('id')
        .where('reverses_journal_id', '=', journalId)
        .executeTakeFirst();
      return { created: false, journalId: existing?.id };
    }
    const original = await db
      .selectFrom('ujira.ledger_entries as e')
      .innerJoin('ujira.ledger_accounts as a', 'a.id', 'e.account_id')
      .select(['a.kind', 'e.amount'])
      .where('e.journal_id', '=', journalId)
      .execute();
    await writeEntries(
      db,
      inserted.id,
      journal.mandate_instance_id,
      original.map((entry) => ({ kind: accountKind(entry.kind), amount: -BigInt(entry.amount) })),
    );
    return { created: true, journalId: inserted.id };
  },

  // The entries of one account, in sequence.
  entries: async (db: Tx, accountId: string, page: PageRequest): Promise<Page<LedgerEntry>> => {
    const limit = checkedLimit(page.limit);
    let query = db
      .selectFrom('ujira.ledger_entries')
      .select(entryColumns)
      .where('account_id', '=', accountId)
      .orderBy('account_seq')
      .limit(limit + 1);
    if (page.after !== undefined) {
      if (!SEQ_KEY.test(page.after)) {
        throw new PageRequestError('after is not a key this list returned');
      }
      query = query.where('account_seq', '>', page.after);
    }
    return pageOf((await query.execute()).map(toEntry), limit, (entry) =>
      entry.accountSeq.toString(),
    );
  },

  // What the contract's state() reported at a ledger. Recording the same
  // ledger again changes nothing; true when this one was new.
  recordState: async (db: Tx, state: MandateState): Promise<boolean> => {
    const inserted = await db
      .insertInto('ujira.mandate_state_snapshots')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        mandate_instance_id: state.mandateInstanceId,
        ledger: state.ledger,
        balance: state.balance.toString(),
        pending: state.pending.toString(),
        committed: state.committed.toString(),
        spent: state.spent.toString(),
      })
      .onConflict((conflict) =>
        conflict.constraint('mandate_state_snapshots_per_ledger').doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    return inserted !== undefined;
  },

  // The latest state() of an instance beside the books, or undefined before
  // one was recorded.
  reconciliation: async (
    db: Tx,
    mandateInstanceId: string,
  ): Promise<Reconciliation | undefined> => {
    const row = await db
      .selectFrom('ujira.ledger_reconciliation')
      .selectAll()
      .where('mandate_instance_id', '=', mandateInstanceId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const big = (value: string | null): bigint => BigInt(value ?? '0');
    return {
      mandateInstanceId,
      ledger: big(row.ledger),
      state: {
        balance: big(row.state_balance),
        pending: big(row.state_pending),
        committed: big(row.state_committed),
        spent: big(row.state_spent),
      },
      books: {
        balance: big(row.ledger_balance),
        pending: big(row.ledger_pending),
        committed: big(row.ledger_committed),
        spent: big(row.ledger_spent),
      },
      matches: row.matches === true,
    };
  },
};

export const ledgerRepositories = { ledger } as const;
