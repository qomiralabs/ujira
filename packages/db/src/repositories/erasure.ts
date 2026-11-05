// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Per-subject data keys and erasure. A value is encrypted under its subject's own
// data key, and the data key is stored wrapped by the key manager, so a leaked
// database holds nothing readable. Erasing a subject destroys the wrapped key.
//
// As everywhere, no method takes a tenant id: the binding for the key manager and
// the cipher comes from the transaction's own context.

import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import { newDataKey, open, seal, type EnvelopeBinding } from '../envelope.js';
import type { KeyManager, KeyWrapAad } from '../key-manager/port.js';
import type { Schema } from '../schema.generated.js';
import { recipientIdentities, type EncryptedValue } from './recipients.js';

type Tx = Kysely<Schema>;

const CURRENT_PRINCIPAL = sql<string>`ujira.current_principal_id()`;
const CURRENT_PROJECT = sql<string>`ujira.current_project_id()`;

const SCHEMA_VERSION = 1;

// A call to a remote key manager happens inside the caller's transaction, so a
// slow one must not hold its locks for long.
const KEY_MANAGER_TIMEOUT_MS = 5000;

// The subject was erased, so its data can never be read or written again.
export class SubjectErasedError extends Error {
  readonly code = 'SUBJECT_ERASED';

  constructor() {
    super('this subject has been erased');
    this.name = 'SubjectErasedError';
  }
}

// There is nothing encrypted for this subject here, or it is not this tenant's.
export class SubjectKeyMissingError extends Error {
  readonly code = 'SUBJECT_KEY_MISSING';

  constructor() {
    super('this subject has no data key');
    this.name = 'SubjectKeyMissingError';
  }
}

async function bindingFor(db: Tx, subjectId: string): Promise<EnvelopeBinding> {
  const result = await sql<{ principal_id: string; project_id: string }>`
    select ujira.current_principal_id() as principal_id, ujira.current_project_id() as project_id
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('the tenant context returned no row');
  return { principalId: row.principal_id, projectId: row.project_id, subjectId };
}

function wrapAad(binding: EnvelopeBinding, schemaVersion: number): KeyWrapAad {
  return { ...binding, schemaVersion };
}

interface KeyRow {
  readonly wrapped_key: Buffer | null;
  readonly kek_id: string | null;
  readonly schema_version: string;
  readonly shredded_at: Date | null;
}

async function keyRow(db: Tx, subjectId: string): Promise<KeyRow | undefined> {
  return db
    .selectFrom('ujira.data_keys')
    .select(['wrapped_key', 'kek_id', 'schema_version', 'shredded_at'])
    .where('subject_id', '=', subjectId)
    .executeTakeFirst();
}

async function unwrap(
  keyManager: KeyManager,
  row: KeyRow,
  binding: EnvelopeBinding,
): Promise<Uint8Array> {
  if (row.shredded_at !== null || row.wrapped_key === null || row.kek_id === null) {
    throw new SubjectErasedError();
  }
  return keyManager.unwrap(
    row.wrapped_key,
    row.kek_id,
    wrapAad(binding, Number(row.schema_version)),
    { signal: AbortSignal.timeout(KEY_MANAGER_TIMEOUT_MS) },
  );
}

// The subject's data key in the clear, creating it on first use. Of two first uses
// racing, one key wins and the other is thrown away unused.
async function dataKeyFor(
  db: Tx,
  keyManager: KeyManager,
  subjectId: string,
  binding: EnvelopeBinding,
): Promise<Uint8Array> {
  const existing = await keyRow(db, subjectId);
  if (existing !== undefined) return unwrap(keyManager, existing, binding);
  const dataKey = newDataKey();
  const wrapped = await keyManager.wrap(dataKey, wrapAad(binding, SCHEMA_VERSION), {
    signal: AbortSignal.timeout(KEY_MANAGER_TIMEOUT_MS),
  });
  const inserted = await db
    .insertInto('ujira.data_keys')
    .values({
      principal_id: CURRENT_PRINCIPAL,
      project_id: CURRENT_PROJECT,
      subject_id: subjectId,
      wrapped_key: Buffer.from(wrapped.wrapped),
      kek_id: wrapped.kekId,
      schema_version: SCHEMA_VERSION,
    })
    .onConflict((conflict) =>
      conflict.columns(['principal_id', 'project_id', 'subject_id']).doNothing(),
    )
    .returning('subject_id')
    .executeTakeFirst();
  if (inserted !== undefined) return dataKey;
  dataKey.fill(0);
  const winner = await keyRow(db, subjectId);
  if (winner === undefined) throw new SubjectKeyMissingError();
  return unwrap(keyManager, winner, binding);
}

export const subjectKeys = {
  // Encrypts under the subject's own key. The caller stores the result where it
  // belongs: recipientPii or a payout method's details. Refused with
  // SubjectErasedError once the subject is erased.
  encrypt: async (
    db: Tx,
    keyManager: KeyManager,
    subjectId: string,
    plaintext: Uint8Array,
  ): Promise<EncryptedValue> => {
    const binding = await bindingFor(db, subjectId);
    const dataKey = await dataKeyFor(db, keyManager, subjectId, binding);
    try {
      return seal(dataKey, plaintext, binding);
    } finally {
      dataKey.fill(0);
    }
  },

  decrypt: async (
    db: Tx,
    keyManager: KeyManager,
    subjectId: string,
    value: EncryptedValue,
  ): Promise<Buffer> => {
    const binding = await bindingFor(db, subjectId);
    const row = await keyRow(db, subjectId);
    if (row === undefined) throw new SubjectKeyMissingError();
    const dataKey = await unwrap(keyManager, row, binding);
    try {
      return open(dataKey, value, binding);
    } finally {
      dataKey.fill(0);
    }
  },
};

export interface ErasureEntry {
  readonly erasureId: string;
  readonly event: string;
  readonly occurredAt: Date;
}

export const erasure = {
  // All of it in the caller's transaction, so a failure leaves nothing half erased.
  // True when this call did the erasing; false when the subject is already erased,
  // or is not one this tenant can see. Payouts and receipts are not touched: they
  // keep recipient_id and recipient_ref, which identify nobody on their own.
  erase: async (db: Tx, subjectId: string): Promise<boolean> => {
    const subject = await db
      .selectFrom('ujira.recipients')
      .select('status')
      .where('id', '=', subjectId)
      .forUpdate()
      .executeTakeFirst();
    if (subject === undefined || subject.status === 'erased') return false;

    const erasureId = randomUUID();
    const log = async (event: 'requested' | 'completed'): Promise<void> => {
      await db
        .insertInto('ujira.erasure_log')
        .values({
          principal_id: CURRENT_PRINCIPAL,
          project_id: CURRENT_PROJECT,
          erasure_id: erasureId,
          subject_id: subjectId,
          event,
        })
        .execute();
    };

    await log('requested');
    await db
      .updateTable('ujira.data_keys')
      .set({ wrapped_key: null, kek_id: null, shredded_at: sql`now()` })
      .where('subject_id', '=', subjectId)
      .where('shredded_at', 'is', null)
      .execute();
    // A subject that never had a key still gets a tombstone, so it cannot get one
    // from here on.
    await db
      .insertInto('ujira.data_keys')
      .values({
        principal_id: CURRENT_PRINCIPAL,
        project_id: CURRENT_PROJECT,
        subject_id: subjectId,
        shredded_at: sql`now()`,
      })
      .onConflict((conflict) =>
        conflict.columns(['principal_id', 'project_id', 'subject_id']).doNothing(),
      )
      .execute();
    await db.deleteFrom('ujira.recipient_pii').where('recipient_id', '=', subjectId).execute();
    await db
      .updateTable('ujira.payout_methods')
      .set({ details_ciphertext: null, details_nonce: null })
      .where('recipient_id', '=', subjectId)
      .execute();
    await recipientIdentities.erase(db, subjectId);
    await db
      .updateTable('ujira.recipients')
      .set({ status: 'erased' })
      .where('id', '=', subjectId)
      .execute();
    await log('completed');
    return true;
  },

  log: async (db: Tx, subjectId: string): Promise<readonly ErasureEntry[]> => {
    const rows = await db
      .selectFrom('ujira.erasure_log')
      .select(['erasure_id', 'event', 'occurred_at'])
      .where('subject_id', '=', subjectId)
      .orderBy('occurred_at')
      .orderBy('event', 'desc')
      .execute();
    return rows.map((row) => ({
      erasureId: row.erasure_id,
      event: row.event,
      occurredAt: row.occurred_at,
    }));
  },
};

export const erasureRepositories = { subjectKeys, erasure } as const;
