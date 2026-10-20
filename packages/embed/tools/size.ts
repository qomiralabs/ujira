// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Fails when the widget grows past its budget.
//
//   pnpm --filter @ujira/embed size

import { join } from 'node:path';

import { BUDGET_BYTES, bundleWidget } from './bundle.ts';

const root = join(import.meta.dirname, '..');
const bundle = await bundleWidget(root);
const kb = (bytes: number): string => (bytes / 1024).toFixed(1);

process.stdout.write(
  `ujira-embed.js: ${kb(bundle.bytes)} KB raw, ${kb(bundle.gzipBytes)} KB gzipped, ` +
    `budget ${kb(BUDGET_BYTES)} KB\n`,
);

// The development build of the renderer carries warnings and extra checks no
// recipient should pay for.
if (bundle.code.includes('dev mode')) {
  process.stderr.write('the bundle carries the development build of the renderer\n');
  process.exitCode = 1;
}

if (bundle.gzipBytes > BUDGET_BYTES) {
  process.stderr.write(
    `size budget exceeded by ${kb(bundle.gzipBytes - BUDGET_BYTES)} KB gzipped\n`,
  );
  process.exitCode = 1;
}
