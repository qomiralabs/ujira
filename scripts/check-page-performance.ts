// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Prints every sample of every asserted page metric, per route, with the
// median, the spread and the bar. Fails only when the measurement itself is
// missing or incomplete, never on a timing value. Run after lhci:
//
//   node scripts/check-page-performance.ts <lighthouserc.json> <report folder>

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildReport, formatReport, PagePerformanceError } from './page-performance.ts';

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

const ROOT = resolve(import.meta.dirname, '..');
const [configArg, directoryArg] = process.argv.slice(2);

if (configArg === undefined || directoryArg === undefined) {
  process.stderr.write(
    'usage: node scripts/check-page-performance.ts <lighthouserc.json> <report folder>\n',
  );
  process.exitCode = 2;
} else {
  try {
    const configText = readFileSync(resolve(ROOT, configArg), 'utf8');
    process.stdout.write(
      formatReport(buildReport(configText, configArg, resolve(ROOT, directoryArg))),
    );
  } catch (error) {
    if (error instanceof PagePerformanceError) {
      process.stderr.write(`Page measurement check failed: ${error.message}\n`);
      process.exitCode = 1;
    } else if (isMissingFile(error)) {
      process.stderr.write(`Page measurement check failed: ${configArg} is missing\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
