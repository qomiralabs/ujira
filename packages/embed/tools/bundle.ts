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
 * A licence notice from a dependency. The renderer's licence asks for its
 * notice in binary redistributions, and this file is redistributed: it loads
 * into someone else's page. Bundlers keep legal comments by default, and this
 * fails if a future build option stops.
 */
export const LICENCE_NOTICE = /@license|SPDX-License-Identifier|Copyright \(c\)/;

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
