// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Proves the three database bans are wired into the real ESLint config:
// the driver and the query builder are importable only inside packages/db,
// type parsers cannot be changed anywhere, and a session level SET of a
// tenant key is refused in repository source. Snippets are linted in memory
// under real file paths, so the scoped configuration applies exactly as it
// would to a committed file.

import path from 'node:path';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const INSIDE_DB = path.join(REPO_ROOT, 'packages/db/src/database.ts');
const INSIDE_DB_SPIKE = path.join(REPO_ROOT, 'packages/db/spikes/supabase/harness.ts');
const IN_CORE = path.join(REPO_ROOT, 'packages/core/src/index.ts');
const IN_PAYOUTS = path.join(REPO_ROOT, 'packages/payouts/src/index.ts');
const IN_CORE_TEST = path.join(REPO_ROOT, 'packages/core/src/index.test.ts');

const HEADER = [
  '// Copyright (c) 2026 Qomira Labs. All rights reserved.',
  '// Proprietary and confidential. Unauthorized copying is prohibited.',
  '',
].join('\n');

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

async function errorsFor(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(HEADER + code, { filePath });
  if (result === undefined) throw new Error('ESLint returned no result');
  const fatal = result.messages.filter((message) => message.fatal === true);
  expect(fatal.map((message) => message.message)).toEqual([]);
  return result.messages
    .filter((message) => message.severity === 2 && message.ruleId !== null)
    .map((message) => `${String(message.ruleId)}: ${message.message}`);
}

describe('no-pg-outside-db', () => {
  it.each([
    ["import pg from 'pg';\nexport const client = pg.Client;\n", 'pg'],
    ["import { Pool } from 'pg';\nexport const pool = Pool;\n", 'pg named'],
    ["import { Kysely } from 'kysely';\nexport const k = Kysely;\n", 'kysely'],
    ["import migrate from 'node-pg-migrate';\nexport const m = migrate;\n", 'node-pg-migrate'],
    ["export type { Schema } from '@ujira/db/src/schema.generated.js';\n", 'db internals'],
  ])('fails in packages/core for %s', async (code) => {
    const errors = await errorsFor(code, IN_CORE);
    expect(errors.filter((error) => error.startsWith('no-restricted-imports'))).not.toHaveLength(0);
  });

  it('fails in packages/payouts too, so the ban is not core only', async () => {
    const errors = await errorsFor(
      "import pg from 'pg';\nexport const c = pg.Client;\n",
      IN_PAYOUTS,
    );
    expect(errors.filter((error) => error.startsWith('no-restricted-imports'))).not.toHaveLength(0);
  });

  it('fails in a test file as well, since a test can leak a connection too', async () => {
    const errors = await errorsFor(
      "import pg from 'pg';\nexport const c = pg.Client;\n",
      IN_CORE_TEST,
    );
    expect(errors.filter((error) => error.startsWith('no-restricted-imports'))).not.toHaveLength(0);
  });

  it('passes inside packages/db', async () => {
    const errors = await errorsFor(
      "import pg from 'pg';\nimport { Kysely } from 'kysely';\nexport const both = [pg.Client, Kysely];\n",
      INSIDE_DB,
    );
    expect(errors.filter((error) => error.startsWith('no-restricted-imports'))).toEqual([]);
  });

  it('passes in the db package spikes, which are inside it', async () => {
    const errors = await errorsFor(
      "import pg from 'pg';\nexport const c = pg.Client;\n",
      INSIDE_DB_SPIKE,
    );
    expect(errors.filter((error) => error.startsWith('no-restricted-imports'))).toEqual([]);
  });

  it('allows the public entry of the package', async () => {
    const errors = await errorsFor("export type { TenantContext } from '@ujira/db';\n", IN_CORE);
    expect(errors.filter((error) => error.startsWith('no-restricted-imports'))).toEqual([]);
  });
});

describe('no-set-type-parser', () => {
  it.each([
    ["import { types } from 'pg';\ntypes.setTypeParser(1082, String);\n", 'through types'],
    [
      'declare const pool: { setTypeParser: (id: number) => void };\npool.setTypeParser(1082);\n',
      'on any object',
    ],
  ])('fails inside packages/db for %s', async (code) => {
    const errors = await errorsFor(code, INSIDE_DB);
    expect(
      errors.filter((error) => error.includes('Type parsers stay as pg ships them')),
    ).not.toHaveLength(0);
  });

  it('fails outside packages/db as well, because the ban is repository wide', async () => {
    const errors = await errorsFor(
      'declare const types: { setTypeParser: (id: number) => void };\ntypes.setTypeParser(1082);\n',
      IN_CORE,
    );
    expect(
      errors.filter((error) => error.includes('Type parsers stay as pg ships them')),
    ).not.toHaveLength(0);
  });

  it('leaves an unrelated call alone', async () => {
    const errors = await errorsFor(
      'declare const parser: { setTypeName: (id: number) => void };\nparser.setTypeName(1082);\n',
      INSIDE_DB,
    );
    expect(errors.filter((error) => error.includes('Type parsers stay as pg ships them'))).toEqual(
      [],
    );
  });
});

describe('no-session-set-of-tenant-keys', () => {
  it.each([
    ['export const sql = "set ujira.principal_id = \'p\'";\n', 'a set in a string'],
    ['export const sql = `set ujira.scope = ${1}`;\n', 'a set in a template'],
    ["export const sql = 'reset ujira.principal_id';\n", 'a reset'],
    [
      'export const sql = "select set_config(\'ujira.principal_id\', $1, false)";\n',
      'a session scoped set_config',
    ],
  ])('fails in repository source for %s', async (code) => {
    const errors = await errorsFor(code, INSIDE_DB);
    expect(errors.filter((error) => error.startsWith('no-restricted-syntax'))).not.toHaveLength(0);
  });

  it('allows the transaction local form', async () => {
    const errors = await errorsFor(
      'export const sql = "select set_config(\'ujira.principal_id\', $1, true)";\n',
      INSIDE_DB,
    );
    expect(errors.filter((error) => error.startsWith('no-restricted-syntax'))).toEqual([]);
  });

  it('exempts tests, which write these statements to prove they are refused', async () => {
    const errors = await errorsFor(
      'export const sql = "set ujira.principal_id = \'p\'";\n',
      path.join(REPO_ROOT, 'packages/db/src/tenant.test.ts'),
    );
    expect(errors.filter((error) => error.startsWith('no-restricted-syntax'))).toEqual([]);
  });
});

describe('the database block restates the rest of the fence', () => {
  // Code review stripped all four restated groups out of the narrow
  // packages/db block at once and the repository still linted clean, so
  // nothing held them there. These four cases pin them: the block lifts the
  // driver ban only, and every other fence rule still applies inside this
  // package.
  it('keeps the money import fence', async () => {
    const errors = await errorsFor(
      "import { build } from '../core/src/money/money.js';\nexport const b = build;\n",
      INSIDE_DB,
    );
    expect(
      errors.filter((error) => error.includes('internal to the money module')),
    ).not.toHaveLength(0);
  });

  it('keeps the runtime loader ban', async () => {
    const errors = await errorsFor(
      "import vm from 'node:vm';\nexport const v: unknown = vm;\n",
      INSIDE_DB,
    );
    expect(errors.filter((error) => error.startsWith('no-restricted-imports'))).not.toHaveLength(0);
  });

  it('keeps the dynamic import rule', async () => {
    const errors = await errorsFor(
      'export const load = async (name: string): Promise<unknown> => import(name);\n',
      INSIDE_DB,
    );
    expect(
      errors.filter((error) => error.includes('plain string path so the import fence')),
    ).not.toHaveLength(0);
  });

  it('keeps the process.getBuiltinModule ban', async () => {
    const errors = await errorsFor(
      "export const m: unknown = globalThis.process.getBuiltinModule('node:module');\n",
      INSIDE_DB,
    );
    expect(errors.filter((error) => error.startsWith('no-restricted-properties'))).not.toHaveLength(
      0,
    );
  });
});
