// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Fails when the widget grows past its budget.
//
//   pnpm --filter @ujira/embed size

import { join } from 'node:path';

import {
  BUDGET_BYTES,
  bundleWidget,
  DEV_MARKER,
  EXPECTED_NOTICES,
  EXPECTED_NOTICE_BLOCKS,
  licenceNotices,
  TAG_NAME,
} from './bundle.ts';

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

// These notices, not any notice. The dependencies' licences ask for their
// notices in binary redistributions, and this file is redistributed into
// other people's pages, so both a dropped notice and an unreviewed arrival
// have to fail.
const notices = licenceNotices(bundle.code);
const distinct = [...new Set(notices)].sort();
const expected = [...EXPECTED_NOTICES].sort();
const missing = expected.filter((line) => !distinct.includes(line));
const extra = distinct.filter((line) => !expected.includes(line));
if (missing.length > 0) {
  process.stderr.write(`the bundle has stopped carrying: ${missing.join('; ')}\n`);
  process.exitCode = 1;
}
if (extra.length > 0) {
  process.stderr.write(
    `the bundle carries a notice nobody reviewed: ${extra.join('; ')}\n` +
      'Add it to EXPECTED_NOTICES once its licence has been checked.\n',
  );
  process.exitCode = 1;
}
if (notices.length !== EXPECTED_NOTICE_BLOCKS) {
  process.stderr.write(
    `the bundle carries ${String(notices.length)} licence blocks, expected ` +
      `${String(EXPECTED_NOTICE_BLOCKS)}: a notice has been dropped or added\n`,
  );
  process.exitCode = 1;
}

if (bundle.gzipBytes > BUDGET_BYTES) {
  process.stderr.write(
    `size budget exceeded by ${kb(bundle.gzipBytes - BUDGET_BYTES)} KB gzipped\n`,
  );
  process.exitCode = 1;
}
