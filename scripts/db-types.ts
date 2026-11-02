// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generates src/schema.generated.ts from the migrated schema, so the types
// the query layer uses are the schema the migrations produce rather than a
// hand written copy of it.
//
// It starts a throwaway Postgres, runs every migration into it, asks
// kysely-codegen for the types, and writes them with this repository's
// licence header. CI runs this and fails if the committed file differs, the
// way it does for the third party notices, so a migration cannot change the
// schema and leave the types behind.
//
// Usage: pnpm db:types, or pnpm --filter @ujira/db db:types

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { format, resolveConfig } from 'prettier';

import { runMigrations } from '../packages/db/src/migrate.ts';
import { POSTGRES_IMAGE } from '../packages/db/src/testing/image.ts';

const OUT_FILE = fileURLToPath(new URL('../packages/db/src/schema.generated.ts', import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL('../packages/db', import.meta.url));

const HEADER = `// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generated from the migrations by \`pnpm --filter @ujira/db db:types\`.
// Do not edit by hand: CI regenerates this file and fails if it differs.
`;

async function main(): Promise<void> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  try {
    const url = container.getConnectionUri();
    await runMigrations({ databaseUrl: url, direction: 'up' });
    execFileSync(
      'node_modules/.bin/kysely-codegen',
      ['--url', url, '--dialect', 'postgres', '--out-file', OUT_FILE],
      { cwd: PACKAGE_DIR, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    // kysely-codegen names the root interface DB and writes its own banner.
    // Both are replaced: the header is this repository's, and the name says
    // what it is where the query layer imports it.
    const generated = readFileSync(OUT_FILE, 'utf8')
      .replace(/^\/\*\*[\s\S]*?\*\/\n/, '')
      .replace(/\bexport interface DB\b/, 'export interface Schema')
      // The first jsonb column brings this object type, written in a form the
      // lint rules refuse, and generated code gets no exception from them.
      .replace(/export type JsonObject = \{([\s\S]*?)\n\};/, 'export interface JsonObject {$1\n}');
    if (!generated.includes('export interface Schema')) {
      throw new Error('kysely-codegen did not produce the root interface this expected to rename');
    }
    // Formatted here, so the committed file passes the format gate and a
    // regeneration produces the same bytes.
    const formatted = await format(`${HEADER}\n${generated.trimStart()}`, {
      ...(await resolveConfig(OUT_FILE)),
      filepath: OUT_FILE,
    });
    writeFileSync(OUT_FILE, formatted);
    process.stdout.write(`db:types wrote ${OUT_FILE}\n`);
  } finally {
    await container.stop();
  }
}

await main();
