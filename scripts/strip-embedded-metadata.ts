// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Removes embedded provenance manifests (C2PA) and XMP packets from SVG, PNG
// and JPEG files in place, for use when brand assets are added. Kept PNG
// chunks and JPEG segments are copied byte for byte and SVG markup outside the
// removed blocks is left as it is, so the image renders the same. A file is
// only written when the result passes the check. Symlinks are refused so a
// file outside the repository is never rewritten.
//
//   node scripts/strip-embedded-metadata.ts <file...>

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';

import { findEmbeddedMetadata, showPath, stripEmbeddedMetadata } from './embedded-metadata.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('Usage: node scripts/strip-embedded-metadata.ts <file...>\n');
  process.exitCode = 2;
}

for (const file of files) {
  const shown = showPath(Buffer.from(file));
  try {
    if (!lstatSync(file).isFile()) throw new Error('not a regular file');
    const data = readFileSync(file);
    const found = findEmbeddedMetadata(file, data);
    const stripped = stripEmbeddedMetadata(file, data);
    if (stripped.equals(data)) {
      process.stdout.write(`${shown}: clean\n`);
      continue;
    }
    writeFileSync(file, stripped);
    process.stdout.write(`${shown}: stripped ${found.join('; ')}\n`);
  } catch (error) {
    process.stderr.write(`${shown}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
