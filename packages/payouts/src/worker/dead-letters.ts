// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Putting a dead letter back on the queue, once an operator has decided to.

import { deadLetters, type Database, type ProjectContext } from '@ujira/db';

import { enqueueTask, TENANT_TASKS, type TenantTask } from './tasks.js';

export class UnknownTaskError extends Error {
  override readonly name = 'UnknownTaskError';

  constructor(task: string) {
    super(`no task named ${task} is registered, so its dead letter cannot be replayed`);
  }
}

// The new job's id, or undefined when there is nothing to do: no such letter under
// this tenant, or one already replayed. The mark and the job commit together, and
// the mark is compare and set, so two operators make one job. It starts again from
// the first try.
export async function replayDeadLetter(
  db: Database,
  context: ProjectContext,
  id: string,
  tasks: readonly TenantTask[] = TENANT_TASKS,
): Promise<bigint | undefined> {
  return db.tenant(context).transaction(async (tx) => {
    const letter = await deadLetters.get(tx, id);
    if (letter?.replayedAt !== null) return undefined;
    const task = tasks.find((candidate) => candidate.name === letter.task);
    if (task === undefined) throw new UnknownTaskError(letter.task);
    if (!(await deadLetters.markReplayed(tx, id))) return undefined;
    return enqueueTask(tx, task, letter.ids);
  });
}
