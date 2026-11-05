// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Keeps erasures true across a restore. Run `export` on a schedule and store the file
// outside the database's backups. Run `replay` after any restore, before traffic is
// admitted, with the newest export. Any erasure newer than that export stays undone,
// so how often it runs sets how far an erasure can lag a restore.
//
// Usage, with UJIRA_DB_OPS_URL set to the ujira_ops login:
//   node scripts/db-erasure-replay.ts export <file>
//   node scripts/db-erasure-replay.ts replay <file>

import { runErasureCommand } from '../packages/db/src/erasure-replay.ts';

function fail(message: string): never {
  process.stderr.write(`db-erasure-replay: ${message}\n`);
  process.exit(1);
}

const [command, file] = process.argv.slice(2);
if ((command !== 'export' && command !== 'replay') || file === undefined) {
  fail('usage: db-erasure-replay export|replay <file>');
}
const url = process.env['UJIRA_DB_OPS_URL'];
if (url === undefined || url === '') fail('set UJIRA_DB_OPS_URL to the ujira_ops login');

process.stdout.write(`db-erasure-replay: ${await runErasureCommand(command, file, url)}\n`);
