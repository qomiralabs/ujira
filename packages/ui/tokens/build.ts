// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Writes the generated token and icon files. The tests compare the committed
// files against a fresh generation, so run this after changing any source.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateOutputs, OUTPUT_FILES } from './generate.ts';

const root = join(import.meta.dirname, '..');
const outputs = await generateOutputs(root);
for (const file of OUTPUT_FILES) {
  writeFileSync(join(root, file), outputs[file]);
  process.stdout.write(`wrote ${file}\n`);
}
