// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The shared vectors and spec tables, copied byte for byte from the
// contracts repository into packages/chain-adapter/spec. SOURCE.json names
// the repository and commit and holds the SHA-256 of every copied file; a
// test pins the hash of SOURCE.json itself, so neither a vector nor the
// list of hashes can change without the test failing.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { hexOf, sha256 } from '../bytes.js';

import type { Json } from './json.js';

export const VENDORED_DIR = path.resolve(import.meta.dirname, '../../../spec');
export const MANIFEST = 'SOURCE.json';

const manifestSchema = z
  .object({
    repository: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    note: z.string(),
    // A list of objects rather than a map from path to hash, so no line
    // pairs a file name with a hash the way a credential assignment looks.
    files: z.array(
      z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    ),
  })
  .strict();

export type VendoredManifest = z.infer<typeof manifestSchema>;

/** Reads a file of the vendored folder by its path relative to it. */
export type ReadVendored = (relative: string) => Uint8Array;

export const readFromDisk: ReadVendored = (relative) =>
  Uint8Array.from(readFileSync(path.join(VENDORED_DIR, relative)));

/** Every file in the vendored folder, relative to it, with / separators. */
export function listVendored(dir: string = VENDORED_DIR): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .map((relative) => relative.split(path.sep).join('/'))
    .sort();
}

export function sha256Hex(bytes: Uint8Array): string {
  return hexOf(sha256(bytes)).slice(2);
}

export function parseManifest(bytes: Uint8Array): VendoredManifest {
  return manifestSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
}

/**
 * Every way the vendored files differ from the manifest: a file whose bytes
 * changed, one that is missing, and one the manifest does not list.
 */
export function vendoredProblems(
  manifest: VendoredManifest,
  files: readonly string[],
  read: ReadVendored,
): string[] {
  const problems: string[] = [];
  const listed = manifest.files.map((f) => f.path);
  for (const { path: file, sha256 } of manifest.files) {
    if (!files.includes(file)) {
      problems.push(`${file}: missing`);
      continue;
    }
    if (sha256Hex(read(file)) !== sha256) problems.push(`${file}: changed`);
  }
  for (const file of files) {
    if (file !== MANIFEST && !listed.includes(file)) problems.push(`${file}: not in the manifest`);
  }
  return problems;
}

/** One vendored JSON file, parsed. */
export function readJson(relative: string, read: ReadVendored = readFromDisk): Json {
  return JSON.parse(Buffer.from(read(relative)).toString('utf8')) as Json;
}
