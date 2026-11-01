// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR } from '../packages/db/src/migrate.ts';
import {
  blankNonCode,
  checkMigration,
  formatProblem,
  splitStatements,
  upSectionForLint,
} from './migration-rules.ts';

const ROOT = join(import.meta.dirname, '..');
const NAME = '1761004800001_example.sql';
const TIMEOUTS = "set local lock_timeout = '5s';\nset local statement_timeout = '60s';\n";

function migration(up: string, down = 'select 1;', header = '-- expand'): string {
  return `${header}\n\n-- Up Migration\n${TIMEOUTS}${up}\n\n-- Down Migration\n${TIMEOUTS}${down}\n`;
}

function messages(source: string, file = NAME): string[] {
  return checkMigration(file, source).map((problem) => problem.message);
}

describe('check-migrations', () => {
  it('passes a well formed expand migration', () => {
    expect(messages(migration('create table ujira.things (id bigint primary key);'))).toEqual([]);
  });

  it('passes a contract migration', () => {
    expect(
      messages(migration('alter table ujira.things drop column old;', 'select 1;', '-- contract')),
    ).toEqual([]);
  });

  it('missing declaration fails', () => {
    const source = migration('select 1;').replace('-- expand\n', '-- a comment\n');
    expect(messages(source)).toEqual(['the first line must be "-- expand" or "-- contract"']);
  });

  it('a declaration anywhere but the first line fails', () => {
    expect(messages(`\n${migration('select 1;')}`)).toHaveLength(1);
    expect(messages(migration('select 1;').replace('-- expand', '-- Expand'))).toHaveLength(1);
  });

  it('needs both section markers, once each, up first', () => {
    const noDown = '-- expand\n-- Up Migration\nselect 1;\n';
    expect(messages(noDown)).toEqual([
      'needs exactly one "-- Up Migration" line and one "-- Down Migration" line',
    ]);
    const twice = `${migration('select 1;')}-- Up Migration\n`;
    expect(messages(twice)).toHaveLength(1);
    const reversed = '-- expand\n-- Down Migration\nselect 1;\n-- Up Migration\nselect 1;\n';
    expect(messages(reversed)).toEqual(['"-- Up Migration" must come before "-- Down Migration"']);
  });

  it('flags a missing lock timeout, with the line of the section', () => {
    const source = migration('select 1;').replace("set local lock_timeout = '5s';\n", '');
    const problems = checkMigration(NAME, source);
    expect(problems.map((problem) => problem.message)).toEqual([
      'up: set local lock_timeout before any other statement',
    ]);
    expect(problems[0]?.line).toBe(3);
  });

  it('flags a missing statement timeout in the down section too', () => {
    const source = migration('select 1;').replace(
      /(-- Down Migration\n)set local lock_timeout = '5s';\nset local statement_timeout = '60s';/,
      "$1set local lock_timeout = '5s';",
    );
    expect(messages(source)).toEqual([
      'down: set local statement_timeout before any other statement',
    ]);
  });

  it('flags timeouts set after other work', () => {
    const source = `-- expand\n-- Up Migration\nselect 1;\n${TIMEOUTS}-- Down Migration\n${TIMEOUTS}select 1;\n`;
    expect(messages(source)).toEqual([
      'up: set local lock_timeout before any other statement',
      'up: set local statement_timeout before any other statement',
    ]);
  });

  it('flags a session level timeout, which outlives the migration', () => {
    expect(messages(migration("set lock_timeout to '1s';\nselect 1;"))).toEqual([
      'up: use set local lock_timeout: a session setting outlives the migration on its connection',
    ]);
  });

  it('flags an index on a table the migration did not create', () => {
    const problems = checkMigration(
      NAME,
      migration('create index things_name on ujira.things (name);'),
    );
    expect(problems.map(formatProblem)).toEqual([
      `${NAME}:6: up: index on ujira.things, which this migration did not create: build it concurrently in a -- no-transaction migration`,
    ]);
  });

  it('allows an index on a table created earlier in the same section', () => {
    const up = [
      'create table if not exists "ujira"."things" (id bigint primary key, name text);',
      'create unique index things_name on ujira.things (name);',
      'create index on only ujira.things (id);',
    ].join('\n');
    expect(messages(migration(up))).toEqual([]);
  });

  it('flags a concurrent statement inside a transaction', () => {
    expect(
      messages(migration('create index concurrently things_name on ujira.things (name);')),
    ).toEqual([
      'up: a concurrent statement cannot run in a transaction; put it in its own migration with -- no-transaction on the second line',
    ]);
  });

  it('passes a -- no-transaction migration of one concurrent statement per section', () => {
    const source = [
      '-- expand',
      '-- no-transaction',
      '-- Up Migration',
      'create index concurrently if not exists things_name on ujira.things (name);',
      '-- Down Migration',
      'drop index concurrently if exists ujira.things_name;',
      '',
    ].join('\n');
    expect(messages(source)).toEqual([]);
  });

  it('flags a -- no-transaction migration with more than one statement', () => {
    const source = [
      '-- expand',
      '-- no-transaction',
      '-- Up Migration',
      "set lock_timeout = '5s';",
      'create index concurrently things_name on ujira.things (name);',
      '-- Down Migration',
      'drop index concurrently ujira.things_name;',
    ].join('\n');
    expect(messages(source)).toEqual([
      'up: a -- no-transaction migration runs exactly one statement, found 2',
    ]);
  });

  it('flags a plain index build in a -- no-transaction migration', () => {
    const source = [
      '-- expand',
      '-- no-transaction',
      '-- Up Migration',
      'create index things_name on ujira.things (name);',
      '-- Down Migration',
      'drop index concurrently ujira.things_name;',
    ].join('\n');
    expect(messages(source)).toEqual([
      'up: an index built outside a transaction must be built concurrently',
    ]);
  });

  it('flags transaction control, which would break the shared transaction', () => {
    expect(messages(migration('commit;\nselect 1;'))).toEqual([
      'up: transaction control belongs to the runner; a migration must not begin, commit or roll back',
    ]);
  });

  it('flags a file name the runner would sort wrongly', () => {
    expect(messages(migration('select 1;'), '17610048_Example.sql')).toEqual([
      'name it <13 digit timestamp>_<lower case words>.sql',
    ]);
  });

  it('passes every committed migration', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(checkMigration(file, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))).toEqual([]);
    }
  });

  it('fails the unsafe fixture from the command line and passes the real migrations', () => {
    const fixture = join(ROOT, 'scripts/fixtures/migrations/1700000000000_unsafe_index.sql');
    const failed = spawnSync(process.execPath, ['scripts/check-migrations.ts', fixture], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('index on ujira.payouts, which this migration did not create');
    const passed = spawnSync(process.execPath, ['scripts/check-migrations.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain('0 problem(s)');
  });
});

describe('statement splitting', () => {
  it('keeps semicolons inside literals, identifiers, comments and bodies', () => {
    const sql = [
      "select 'a;b', E'it\\'s;';",
      '-- a comment; with a semicolon',
      '/* nested /* comment; */ still; */ select 2;',
      'create function f() returns int language sql as $body$ select 1; $body$;',
      'select $$x;y$$;',
    ].join('\n');
    const statements = splitStatements(sql);
    expect(statements.map((statement) => statement.line)).toEqual([1, 3, 4, 5]);
    expect(statements[2]?.text).toBe('create function f() returns int language sql as');
  });

  it('runs an unterminated literal or comment to the end, as Postgres reads it', () => {
    expect(splitStatements("select 'open; select 2;")).toHaveLength(1);
    expect(splitStatements('select 1; /* open; select 2;')).toHaveLength(1);
    expect(splitStatements('select $x$ open; select 2;')).toHaveLength(1);
  });

  it('blanks without moving a line', () => {
    const sql = "select 'a\nb' -- c\n, 2;";
    const blanked = blankNonCode(sql);
    expect(blanked).toHaveLength(sql.length);
    expect(blanked.split('\n')).toHaveLength(3);
  });

  it('ignores an index built inside a function body', () => {
    const up = 'create function f() returns void language sql as $$ create index i on t (x) $$;';
    expect(messages(migration(up))).toEqual([]);
  });
});

describe('the squawk input', () => {
  it('cuts the down section and keeps every line above it in place', () => {
    const source = migration('create table t (id bigint);', 'drop table t;');
    const up = upSectionForLint(source);
    expect(up).not.toContain('drop table');
    expect(source.startsWith(up)).toBe(true);
  });

  it('returns a file without a down section unchanged', () => {
    expect(upSectionForLint('select 1;\n')).toBe('select 1;\n');
  });
});
