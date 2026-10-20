// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Fails when any route of a built Next.js app loads more first load
// JavaScript, gzipped, than the budget allows. Run after next build:
//
//   node scripts/check-bundle-budget.ts <app folder> [budget in kB, default 250]

import { join } from 'node:path';

import { BudgetError, checkBudget, formatReport, measureRoutes } from './bundle-budget.ts';

const ROOT = join(import.meta.dirname, '..');
const [appArg, budgetArg = '250'] = process.argv.slice(2);

if (appArg === undefined || !/^\d+$/.test(budgetArg)) {
  process.stderr.write('usage: node scripts/check-bundle-budget.ts <app folder> [budget kB]\n');
  process.exitCode = 2;
} else {
  try {
    const result = checkBudget(measureRoutes(join(ROOT, appArg)), Number(budgetArg) * 1000);
    process.stdout.write(formatReport(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof BudgetError)) throw error;
    process.stderr.write(`Bundle budget check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
