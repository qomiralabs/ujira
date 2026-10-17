// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Removes embedded provenance manifests (C2PA) and XMP packets from SVG, PNG
// and JPEG files in place, for use when brand assets are added. Kept PNG
// chunks and JPEG segments are copied byte for byte and SVG markup outside the
// removed blocks is left as it is, so the image renders the same. A file is
// only written when the result passes the check.
//
//   node scripts/strip-embedded-metadata.ts <file...>

import { readFileSync, writeFileSync } from 'node:fs';

import { findEmbeddedMetadata, stripEmbeddedMetadata } from './embedded-metadata.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('Usage: node scripts/strip-embedded-metadata.ts <file...>\n');
  process.exitCode = 2;
}

for (const file of files) {
  try {
    const data = readFileSync(file);
    const found = findEmbeddedMetadata(file, data);
    const stripped = stripEmbeddedMetadata(file, data);
    if (stripped.equals(data)) {
      process.stdout.write(`${file}: clean\n`);
      continue;
    }
    writeFileSync(file, stripped);
    process.stdout.write(`${file}: stripped ${found.join('; ')}\n`);
  } catch (error) {
    process.stderr.write(`${file}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
