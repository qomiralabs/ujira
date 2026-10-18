// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Files that do not come from npm (self hosted fonts, brand graphics, map
// data) are listed in assets.licenses.json with their source and licence.
// This module checks the register against the files in the tree and against
// the asset licence policy, and builds the rows for THIRD_PARTY_NOTICES.md.

import type { AssetNotice } from './license-policy.ts';
import { parseStrictJson, StrictJsonError } from './strict-json.ts';

export type AssetKind = 'font' | 'image' | 'data';

export interface AssetEntry {
  path: string;
  kind: AssetKind;
  source: string;
  license: string;
  copyright: string;
  added: string;
}

// Assets made by Qomira Labs, such as the brand graphics.
export const OWN_LICENSE = 'LicenseRef-QomiraLabs-Proprietary';

export const ASSET_LICENSES: Readonly<Record<AssetKind, readonly string[]>> = {
  font: ['OFL-1.1'],
  image: ['CC0-1.0', 'ISC', 'MIT', OWN_LICENSE],
  data: ['CC0-1.0', 'ISC', 'MIT', OWN_LICENSE],
};

// Every file under these folders must be registered, whatever its type.
export const ASSET_FOLDERS: readonly string[] = [
  'packages/*/assets/**',
  'packages/*/fonts/**',
  'apps/*/public/**',
  'apps/*/assets/**',
];

const FONT_FILE = /\.(?:woff2?|ttf|otf|eot)$/i;
// Fonts, images and map data must be registered wherever they are.
const ASSET_FILE =
  /\.(?:woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|geojson|topojson)$/i;
// A font folder ships the font licence next to the fonts.
const FONT_LICENSE_TEXT = /(?:^|\/)(?:LICENSE|OFL|COPYING)[^/]*$/i;

export class AssetRegisterError extends Error {
  override name = 'AssetRegisterError';
}

// `*` and `?` stay within one path segment, `**` spans any number of them.
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? '';
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        pattern += '(?:[^/]+/)*';
        i += 2;
      } else {
        pattern += '.*';
        i += 1;
      }
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

const FIELDS: readonly (keyof AssetEntry)[] = [
  'path',
  'kind',
  'source',
  'license',
  'copyright',
  'added',
];
const KINDS: readonly string[] = ['font', 'image', 'data'];

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

export function parseAssetRegister(text: string): AssetEntry[] {
  let document: unknown;
  try {
    document = parseStrictJson(text);
  } catch (error) {
    if (error instanceof StrictJsonError) throw new AssetRegisterError(error.message);
    throw error;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new AssetRegisterError('the register must be an object with an "assets" list');
  }
  const top = document as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (key !== 'assets') throw new AssetRegisterError(`unknown top level field "${key}"`);
  }
  const list = top['assets'];
  if (!Array.isArray(list)) throw new AssetRegisterError('"assets" must be a list');

  const entries: AssetEntry[] = [];
  const paths = new Set<string>();
  list.forEach((item: unknown, index) => {
    const where = `assets[${String(index)}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new AssetRegisterError(`${where}: must be an object`);
    }
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!(FIELDS as readonly string[]).includes(key)) {
        throw new AssetRegisterError(`${where}: unknown field "${key}"`);
      }
    }
    const values: Partial<Record<keyof AssetEntry, string>> = {};
    for (const field of FIELDS) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new AssetRegisterError(`${where}: "${field}" must be a non-empty string`);
      }
      values[field] = value;
    }
    const entry = values as AssetEntry;
    if (!KINDS.includes(entry.kind)) {
      throw new AssetRegisterError(`${where}: "kind" must be font, image or data`);
    }
    if (!isHttpsUrl(entry.source)) {
      throw new AssetRegisterError(`${where}: "source" must be an https URL`);
    }
    if (!isValidDate(entry.added)) {
      throw new AssetRegisterError(`${where}: "added" must be a date as YYYY-MM-DD`);
    }
    if (paths.has(entry.path)) {
      throw new AssetRegisterError(`${where}: path "${entry.path}" is listed twice`);
    }
    paths.add(entry.path);
    entries.push(entry);
  });
  return entries;
}

const FOLDER_PATTERNS = ASSET_FOLDERS.map(globToRegExp);

export function isAssetPath(path: string): boolean {
  return ASSET_FILE.test(path) || FOLDER_PATTERNS.some((pattern) => pattern.test(path));
}

export interface AssetResult {
  problems: string[];
  notices: AssetNotice[];
}

export function checkAssets(entries: readonly AssetEntry[], files: readonly string[]): AssetResult {
  const problems: string[] = [];
  const matchers = entries.map((entry) => ({ entry, pattern: globToRegExp(entry.path) }));
  const counts = new Map<AssetEntry, number>(entries.map((entry) => [entry, 0]));

  for (const file of files) {
    const matched = matchers.filter(({ pattern }) => pattern.test(file)).map(({ entry }) => entry);
    for (const entry of matched) counts.set(entry, (counts.get(entry) ?? 0) + 1);
    if (matched.length === 0) {
      if (isAssetPath(file)) problems.push(`${file}: not in assets.licenses.json`);
      continue;
    }
    if (matched.length > 1) {
      problems.push(
        `${file}: matched by more than one entry (${matched.map((e) => e.path).join(', ')})`,
      );
      continue;
    }
    const entry = matched[0];
    if (entry === undefined) continue;
    const isFont = FONT_FILE.test(file);
    if (isFont && entry.kind !== 'font') {
      problems.push(`${file}: a font file must be under a font entry, not ${entry.kind}`);
    } else if (!isFont && entry.kind === 'font' && !FONT_LICENSE_TEXT.test(file)) {
      problems.push(`${file}: not a font file but under the font entry ${entry.path}`);
    }
  }

  const notices: AssetNotice[] = [];
  for (const entry of entries) {
    const allowed = ASSET_LICENSES[entry.kind];
    if (!allowed.includes(entry.license)) {
      problems.push(
        `${entry.path}: license "${entry.license}" not allowed for ${entry.kind} assets (allowed: ${allowed.join(', ')})`,
      );
    }
    const count = counts.get(entry) ?? 0;
    if (count === 0) {
      problems.push(`${entry.path}: matches no file`);
      continue;
    }
    notices.push({
      path: entry.path,
      files: count,
      license: entry.license,
      copyright: entry.copyright,
      source: entry.source,
      added: entry.added,
    });
  }
  return { problems: [...new Set(problems)].sort(), notices };
}
