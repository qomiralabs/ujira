// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Loads every vendored vector file, as the contracts' runner does: every
// JSON file in spec/vectors except the schema, so a vector file added to the
// spec later runs without a change here.

import * as f from './format.js';
import type { LoadedVector } from './format.js';
import type { Json } from './json.js';
import { listVendored, readFromDisk, readJson } from './vendored.js';
import type { ReadVendored } from './vendored.js';

export function vectorFiles(files: readonly string[] = listVendored()): string[] {
  return files.filter(
    (file) => /^vectors\/[^/]+\.json$/.test(file) && file !== 'vectors/schema.json',
  );
}

/** Parses one vector file; anything the runner would act on is checked first. */
export function parseVectorFile(file: string, content: Json): LoadedVector[] {
  const parsed = f.vectorFile.parse(content);
  return parsed.vectors.map((raw) => {
    // The schema has just proved it an object.
    return { file, parsed: f.vector.parse(raw), raw: raw as Record<string, Json> };
  });
}

export function loadVectors(
  files: readonly string[] = vectorFiles(),
  read: ReadVendored = readFromDisk,
): LoadedVector[] {
  return files.flatMap((file) => parseVectorFile(file, readJson(file, read)));
}
