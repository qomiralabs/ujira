// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Fails when the widget grows past its budget.
//
//   pnpm --filter @ujira/embed size

import { join } from 'node:path';

import { BUDGET_BYTES, bundleWidget, DEV_MARKER, LICENCE_NOTICE, TAG_NAME } from './bundle.ts';

const root = join(import.meta.dirname, '..');
const bundle = await bundleWidget(root);
const kb = (bytes: number): string => (bytes / 1024).toFixed(1);

process.stdout.write(
  `ujira-embed.js: ${kb(bundle.bytes)} KB raw, ${kb(bundle.gzipBytes)} KB gzipped, ` +
    `budget ${kb(BUDGET_BYTES)} KB\n`,
);

// The development build of the renderer carries warnings and extra checks no
// recipient should pay for. Looking for a marker string on its own would pass
// in silence the day the renderer reworded it, so the same marker is first
// proved against a development build: if the control stops carrying it, this
// fails loudly instead of waving the production bundle through.
const control = await bundleWidget(root, 'development');
if (!control.code.includes(DEV_MARKER)) {
  process.stderr.write(
    `the development build no longer says "${DEV_MARKER}", so this check can no longer see one\n`,
  );
  process.exitCode = 1;
} else if (bundle.code.includes(DEV_MARKER)) {
  process.stderr.write('the bundle carries the development build of the renderer\n');
  process.exitCode = 1;
}

// A budget that measures something other than the widget is not a budget.
if (!bundle.code.includes(TAG_NAME) || !bundle.code.includes('customElements.define')) {
  process.stderr.write('the bundle does not define the widget element\n');
  process.exitCode = 1;
}

// The renderer's licence asks for its notice in binary redistributions, and
// this file is redistributed: it loads into other people's pages.
if (!LICENCE_NOTICE.test(bundle.code)) {
  process.stderr.write('the bundle carries no licence notice for its dependencies\n');
  process.exitCode = 1;
}

if (bundle.gzipBytes > BUDGET_BYTES) {
  process.stderr.write(
    `size budget exceeded by ${kb(bundle.gzipBytes - BUDGET_BYTES)} KB gzipped\n`,
  );
  process.exitCode = 1;
}
