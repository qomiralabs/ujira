// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Builds the single file a script tag loads. Nothing is written to disk: the
// size check, the test server and the screenshot script all use the code in
// memory, so a build never leaves anything behind in the checkout.

import { gzipSync } from 'node:zlib';

import { build } from 'vite';

export const ENTRY = 'src/index.ts';
export const BUNDLE_PATH = '/ujira-embed.js';

/** The element the bundle must define, so the budget cannot measure something else. */
export const TAG_NAME = 'ujira-onboarding';

/** What the renderer's development build says about itself. */
export const DEV_MARKER = 'dev mode';

/**
 * The copyright line of every licence block the bundle carries, in the order
 * they appear. Only blocks that declare themselves a licence count, so our
 * own proprietary header could never stand in for a dependency's notice.
 */
export function licenceNotices(code: string): string[] {
  return [...code.matchAll(/\/\*[\s\S]*?\*\//g)]
    .map((match) => match[0])
    .filter((block) => block.includes('@license'))
    .map((block) => (/Copyright [^\n*]+/.exec(block) ?? [''])[0].trim())
    .filter((line) => line !== '');
}

/**
 * The notices this bundle is expected to carry, pinned so the check fails in
 * both directions: fewer, and a dependency's notice has been dropped from a
 * file we redistribute into other people's pages, which is what its licence
 * asks us to reproduce; more, and a dependency arrived without review.
 *
 * Asserting that some notice exists would be the wrong shape for a legal
 * obligation, because the obligation is per component rather than per file,
 * and because a single match can be satisfied by the wrong notice entirely.
 *
 * These are keys asserting that upstream's text is present, not a copy of
 * it: the lines below are two short identifiers, while the notice text
 * itself exists here nowhere. The notices in the bundle are upstream's own
 * bytes, preserved by the bundler, so there is no second copy of that text
 * to drift from it. Committing the text to compare against would create
 * exactly the copy that drift needs.
 */
export const EXPECTED_NOTICES: readonly string[] = [
  'Copyright 2017 Google LLC',
  'Copyright 2019 Google LLC',
];

/** How many licence blocks carry those notices. Pinned for the same reason. */
export const EXPECTED_NOTICE_BLOCKS = 4;

/** The budget for the widget: 60 KB gzipped, on the wire. */
export const BUDGET_BYTES = 60 * 1024;

export interface Bundle {
  code: string;
  bytes: number;
  gzipBytes: number;
}

/**
 * Builds the widget. `development` resolves the renderer's development
 * export, which exists only so the size check can prove it can tell the two
 * apart; nothing ships from it.
 */
export async function bundleWidget(root: string, mode = 'production'): Promise<Bundle> {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'warn',
    mode,
    ...(mode === 'development' ? { resolve: { conditions: ['development'] } } : {}),
    build: {
      write: false,
      target: 'es2022',
      minify: true,
      cssCodeSplit: false,
      lib: { entry: ENTRY, formats: ['es'], fileName: 'ujira-embed' },
      // Keeps the dependencies' own licence notices in the file we hand to
      // an integrator, which is what their licences ask of a binary
      // redistribution. Measured cost: 364 bytes before compression.
      rollupOptions: { output: { comments: { legal: true } } },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const code = outputs
    .flatMap((output) => ('output' in output ? output.output : []))
    .filter((chunk) => chunk.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('');
  if (code === '') throw new Error('the build produced no code');
  const bytes = Buffer.byteLength(code);
  return { code, bytes, gzipBytes: gzipSync(code, { level: 9 }).byteLength };
}
