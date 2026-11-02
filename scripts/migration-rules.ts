// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The rules every migration file must meet before it can run against a
// database with traffic on it. squawk lints the SQL itself in CI; these are
// the rules squawk cannot know, because they depend on how this repository
// runs migrations: every transactional migration shares one transaction, a
// `-- no-transaction` migration runs a single statement on its own, and the
// first line says whether the change is expand or contract.

import {
  DOWN_MARKER,
  MigrationFileError,
  parseMigration,
  type MigrationSource,
} from '../packages/db/src/migrate.ts';

export interface Problem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface Statement {
  // Lower case, comments and literals blanked, whitespace collapsed.
  readonly text: string;
  // 1-based, within the text that was split.
  readonly line: number;
}

const FILE_NAME = /^\d{13}_[a-z0-9_]+\.sql$/;

// Replaces comments, string literals and dollar quoted bodies with spaces,
// keeping every newline so line numbers survive. What is left is the code a
// statement split and the patterns below can read without being fooled by a
// semicolon or a keyword inside a literal or a function body.
export function blankNonCode(sql: string): string {
  let out = '';
  let at = 0;
  const blankRun = (end: number): void => {
    out += sql.slice(at, end).replace(/[^\n]/g, ' ');
    at = end;
  };
  while (at < sql.length) {
    const rest = sql.slice(at);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', at);
      blankRun(end === -1 ? sql.length : end);
      continue;
    }
    if (rest.startsWith('/*')) {
      let depth = 0;
      let end = at;
      while (end < sql.length) {
        if (sql.startsWith('/*', end)) {
          depth += 1;
          end += 2;
        } else if (sql.startsWith('*/', end)) {
          depth -= 1;
          end += 2;
          if (depth === 0) break;
        } else {
          end += 1;
        }
      }
      blankRun(end);
      continue;
    }
    const dollar = /^\$([a-z_][a-z0-9_]*)?\$/i.exec(rest);
    if (dollar !== null) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, at + tag.length);
      blankRun(close === -1 ? sql.length : close + tag.length);
      continue;
    }
    if (rest.startsWith("'")) {
      // An E string takes backslash escapes; any other literal does not.
      const escapes = /(?:^|[^a-z0-9_$])e$/i.test(out.trimEnd());
      let end = at + 1;
      while (end < sql.length) {
        const char = sql[end];
        if (escapes && char === '\\') {
          end += 2;
          continue;
        }
        if (char === "'") {
          if (sql[end + 1] === "'") {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      blankRun(end);
      continue;
    }
    out += sql[at] ?? '';
    at += 1;
  }
  return out;
}

// Splits SQL into statements at top level semicolons.
export function splitStatements(sql: string): Statement[] {
  const code = blankNonCode(sql);
  const statements: Statement[] = [];
  let start = 0;
  const push = (end: number): void => {
    const raw = code.slice(start, end);
    const text = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    if (text !== '') {
      const leading = raw.length - raw.trimStart().length;
      const line = code.slice(0, start + leading).split('\n').length;
      statements.push({ text, line });
    }
  };
  for (let at = 0; at < code.length; at += 1) {
    if (code[at] === ';') {
      push(at);
      start = at + 1;
    }
  }
  push(code.length);
  return statements;
}

function unquote(name: string): string {
  return name.replace(/"/g, '');
}

const TRANSACTION_CONTROL =
  /^(?:begin|start transaction|commit|end|rollback|abort|savepoint|release|prepare transaction)\b/;
// The value is a literal, which blanking leaves as nothing, so `to` can end
// the statement text.
const SET_LOCAL = (setting: string): RegExp => new RegExp(`^set local ${setting} ?(?:=|to\\b)`);
const SET_SESSION = (setting: string): RegExp =>
  new RegExp(`^set (?:session )?${setting} ?(?:=|to\\b)`);
const CREATE_TABLE =
  /^create (?:(?:global|local) )?(?:(?:temporary|temp|unlogged) )?table (?:if not exists )?([^\s(]+)/;
const CREATE_INDEX =
  /^create (?:unique )?index (concurrently )?(?:if not exists )?(?:(?!on )\S+ )?on (?:only )?([^\s(]+)/;
const TIMEOUTS = ['lock_timeout', 'statement_timeout'] as const;
const SET_ROLE = /^set (?:local |session )?role (?!none\b)/;
const RESET_ROLE = /^(?:reset role|set (?:local |session )?role none)$/;

function sectionProblems(
  file: string,
  migration: MigrationSource,
  section: 'up' | 'down',
): Problem[] {
  const sql = section === 'up' ? migration.up : migration.down;
  const offset = (section === 'up' ? migration.upLine : migration.downLine) - 1;
  const problems: Problem[] = [];
  const report = (line: number, message: string): void => {
    problems.push({ file, line: line + offset, message: `${section}: ${message}` });
  };
  const statements = splitStatements(sql);

  for (const statement of statements) {
    if (TRANSACTION_CONTROL.test(statement.text)) {
      report(
        statement.line,
        'transaction control belongs to the runner; a migration must not begin, commit or roll back',
      );
    }
  }

  if (!migration.transactional) {
    if (statements.length !== 1) {
      report(
        1,
        `a -- no-transaction migration runs exactly one statement, found ${String(statements.length)}`,
      );
    }
    for (const statement of statements) {
      const index = CREATE_INDEX.exec(statement.text);
      if (index !== null && index[1] === undefined) {
        report(statement.line, 'an index built outside a transaction must be built concurrently');
      }
    }
    return problems;
  }

  // Both timeouts come before anything else, so no statement in the section
  // can wait on a lock forever or run unbounded behind live traffic.
  const firstOther = statements.findIndex(
    (statement) => !TIMEOUTS.some((setting) => SET_LOCAL(setting).test(statement.text)),
  );
  const leading = statements.slice(0, firstOther === -1 ? statements.length : firstOther);
  for (const setting of TIMEOUTS) {
    if (!leading.some((statement) => SET_LOCAL(setting).test(statement.text))) {
      report(1, `set local ${setting} before any other statement`);
    }
  }
  for (const statement of statements) {
    for (const setting of TIMEOUTS) {
      if (SET_SESSION(setting).test(statement.text)) {
        report(
          statement.line,
          `use set local ${setting}: a session setting outlives the migration on its connection`,
        );
      }
    }
  }

  // The runner records each migration in the same transaction, as the
  // session user. A role set for the migration's own statements and left in
  // place makes that record fail, or worse, run as the wrong role.
  let roleSetAt: number | undefined;
  for (const statement of statements) {
    if (SET_ROLE.test(statement.text)) roleSetAt = statement.line;
    if (RESET_ROLE.test(statement.text)) roleSetAt = undefined;
  }
  if (roleSetAt !== undefined) {
    report(roleSetAt, 'a role set here must be reset with reset role before the section ends');
  }

  // A table created earlier in the same section has no readers yet, so
  // indexing it inside the transaction blocks nobody. Any other table is
  // live and needs a concurrent build, which cannot run in a transaction.
  const created = new Set<string>();
  for (const statement of statements) {
    const table = CREATE_TABLE.exec(statement.text);
    if (table?.[1] !== undefined) created.add(unquote(table[1]));
    if (/\bconcurrently\b/.test(statement.text)) {
      report(
        statement.line,
        'a concurrent statement cannot run in a transaction; put it in its own migration with -- no-transaction on the second line',
      );
      continue;
    }
    const index = CREATE_INDEX.exec(statement.text);
    if (index?.[2] !== undefined && !created.has(unquote(index[2]))) {
      report(
        statement.line,
        `index on ${unquote(index[2])}, which this migration did not create: build it concurrently in a -- no-transaction migration`,
      );
    }
  }
  return problems;
}

// Every problem with one migration file. An empty list means it passes.
export function checkMigration(file: string, source: string): Problem[] {
  const problems: Problem[] = [];
  if (!FILE_NAME.test(file)) {
    problems.push({
      file,
      line: 1,
      message: 'name it <13 digit timestamp>_<lower case words>.sql',
    });
  }
  let migration: MigrationSource;
  try {
    migration = parseMigration(file, source);
  } catch (error) {
    if (!(error instanceof MigrationFileError)) throw error;
    return [...problems, { file, line: 1, message: error.message.replace(`${file}: `, '') }];
  }
  return [
    ...problems,
    ...sectionProblems(file, migration, 'up'),
    ...sectionProblems(file, migration, 'down'),
  ];
}

// The file with its down section cut off, for squawk. A down section of an
// expand migration drops what the up section added, which is its job, so
// linting it would only produce noise. The lines before the cut are kept as
// they are, so squawk's line numbers are the file's.
export function upSectionForLint(source: string): string {
  const lines = source.split('\n');
  const down = lines.findIndex((line) => line.replace(/\r$/, '') === DOWN_MARKER);
  return (down === -1 ? lines : lines.slice(0, down)).join('\n');
}

export function formatProblem(problem: Problem): string {
  return `${problem.file}:${String(problem.line)}: ${problem.message}`;
}
