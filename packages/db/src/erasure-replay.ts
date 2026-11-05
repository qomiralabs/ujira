// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A restore from before an erasure brings the erased data back, and with it a log
// that has forgotten the erasure. So the list of erased subjects has to be exported
// regularly and kept outside the backups, and replayed after any restore, before
// traffic is admitted.
//
// Imports nothing from its own package, so scripts/db-erasure-replay.ts can load it
// directly. It only ever calls the two database functions built for this, as the
// ujira_ops login, which can do nothing else with these tables.

import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

import pg from 'pg';
import { z } from 'zod';

const PAGE_SIZE = 1000;

// One line of the export. Ids and a time: nothing here identifies a person, which is
// why it may be kept outside the database.
const ErasedSubject = z.strictObject({
  principalId: z.uuid(),
  projectId: z.uuid(),
  subjectId: z.uuid(),
  erasedAt: z.iso.datetime(),
});
export type ErasedSubject = z.infer<typeof ErasedSubject>;

export interface ReplayResult {
  // The erasures that had come undone and were made true again.
  readonly reapplied: number;
  // Already erased, or a subject the restored database never had.
  readonly unchanged: number;
}

interface ErasedRow {
  id: string;
  principal_id: string;
  project_id: string;
  subject_id: string;
  occurred_at: Date;
}

// Every completed erasure the database knows of, oldest id first, a page at a time
// so a long log never sits in memory all at once.
export async function* exportErasures(client: pg.ClientBase): AsyncGenerator<ErasedSubject> {
  let after: string | null = null;
  for (;;) {
    const page: pg.QueryResult<ErasedRow> = await client.query<ErasedRow>(
      'select * from ujira.erased_subjects($1::uuid, $2::bigint)',
      [after, PAGE_SIZE],
    );
    for (const row of page.rows) {
      yield {
        principalId: row.principal_id,
        projectId: row.project_id,
        subjectId: row.subject_id,
        erasedAt: row.occurred_at.toISOString(),
      };
    }
    const last = page.rows.at(-1);
    if (last === undefined || page.rows.length < PAGE_SIZE) return;
    after = last.id;
  }
}

export function parseExportLine(line: string): ErasedSubject {
  return ErasedSubject.parse(JSON.parse(line));
}

// Safe to run twice, and safe to run on a database that lost nothing. Each subject
// is its own transaction, so a failure part way keeps what was done and a rerun
// finishes the rest. It stops at the first error rather than skipping one: traffic
// must not be admitted while any erasure is still undone.
export async function replayErasures(
  client: pg.ClientBase,
  subjects: Iterable<ErasedSubject> | AsyncIterable<ErasedSubject>,
): Promise<ReplayResult> {
  let reapplied = 0;
  let unchanged = 0;
  for await (const subject of subjects) {
    const result = await client.query<{ changed: boolean }>(
      'select ujira.replay_erasure($1::uuid, $2::uuid, $3::uuid) as changed',
      [subject.principalId, subject.projectId, subject.subjectId],
    );
    if (result.rows[0]?.changed === true) reapplied += 1;
    else unchanged += 1;
  }
  return { reapplied, unchanged };
}

async function* readExport(path: string): AsyncGenerator<ErasedSubject> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() !== '') yield parseExportLine(line);
  }
}

// What scripts/db-erasure-replay.ts runs. It lives here because this package is the
// one that depends on the driver, and the script can only reach it through here.
// An export refuses to overwrite a file, so a failed run cannot destroy the last good
// copy. Returns one line to report.
export async function runErasureCommand(
  command: 'export' | 'replay',
  file: string,
  url: string,
): Promise<string> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (command === 'replay') {
      const result = await replayErasures(client, readExport(file));
      return `${String(result.reapplied)} reapplied, ${String(result.unchanged)} unchanged`;
    }
    const out = createWriteStream(file, { flags: 'wx' });
    await once(out, 'open');
    let count = 0;
    for await (const subject of exportErasures(client)) {
      if (!out.write(`${JSON.stringify(subject)}\n`)) await once(out, 'drain');
      count += 1;
    }
    out.end();
    await once(out, 'finish');
    return `exported ${String(count)} erasure(s)`;
  } finally {
    await client.end();
  }
}
