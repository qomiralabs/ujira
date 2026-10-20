// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The brand mono face has no naira, cedi, peso or rupee sign, so a second
// mono face carries those four and nothing else. These tests read the
// committed subset and the stylesheet that loads it, so a regenerated or
// swapped font file has to keep every property the amount components rely
// on: the four code points, the mono advance width, the size budget and the
// licence the file ships under.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { fonts } from '../tokens/tokens.generated.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const SUBSET = join(PACKAGE_ROOT, 'fonts/noto-sans-mono-currency-signs.woff2');
const LICENSE = join(PACKAGE_ROOT, 'fonts/OFL.txt');
const FONTS_CSS = join(PACKAGE_ROOT, 'styles/fonts.css');

// Naira, peso, cedi and rupee, in code point order.
const SIGNS = [0x20a6, 0x20b1, 0x20b5, 0x20b9];
// Both mono faces advance 0.6 em per character, so an amount keeps its
// column width when a sign comes from the second face.
const MONO_ADVANCE = 0.6;
const SIZE_BUDGET = 10 * 1024;

// WOFF2 reading. The file holds one brotli stream with every table in
// directory order, so a table is found by adding up the lengths before it.
// Only the tags below are read; the rest are skipped by length.

// The 63 table tags WOFF2 writes as an index instead of four bytes, in the
// order the specification fixes.
// prettier-ignore
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'ltag', 'meta', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf',
  'Silf', 'Glat', 'Gloc',
] as const;

interface Reader {
  offset: number;
}

function uint8(data: Buffer, at: number): number {
  const value = data[at];
  if (value === undefined) throw new Error(`the font file ends before byte ${String(at)}`);
  return value;
}

// A length written as seven bits per byte, most significant first, with the
// top bit set on every byte but the last.
function base128(data: Buffer, reader: Reader): number {
  let value = 0;
  for (let read = 0; read < 5; read++) {
    const byte = uint8(data, reader.offset);
    reader.offset += 1;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  throw new Error('a table length is longer than five bytes');
}

function sfntTables(file: Buffer): Map<string, Buffer> {
  if (file.subarray(0, 4).toString('latin1') !== 'wOF2') {
    throw new Error('not a WOFF2 file');
  }
  if (file.subarray(4, 8).toString('latin1') === 'ttcf') {
    throw new Error('font collections are not read here');
  }
  const numTables = file.readUInt16BE(12);
  const compressedSize = file.readUInt32BE(20);
  const reader: Reader = { offset: 48 };
  const directory: { tag: string; length: number; nullTransform: boolean }[] = [];
  for (let index = 0; index < numTables; index++) {
    const flags = uint8(file, reader.offset);
    reader.offset += 1;
    const known = flags & 0x3f;
    let tag: string;
    if (known === 0x3f) {
      tag = file.subarray(reader.offset, reader.offset + 4).toString('latin1');
      reader.offset += 4;
    } else {
      const name = KNOWN_TAGS[known];
      if (name === undefined) throw new Error(`unknown table index ${String(known)}`);
      tag = name;
    }
    const origLength = base128(file, reader);
    // glyf and loca are stored transformed unless the version says otherwise;
    // every other table is stored as it is unless the version says otherwise.
    const version = flags >> 6;
    const nullTransform = tag === 'glyf' || tag === 'loca' ? version === 3 : version === 0;
    const length = nullTransform ? origLength : base128(file, reader);
    directory.push({ tag, length, nullTransform });
  }
  const stream = brotliDecompressSync(file.subarray(reader.offset, reader.offset + compressedSize));
  const tables = new Map<string, Buffer>();
  let at = 0;
  for (const entry of directory) {
    // glyf and loca are the only tables stored in a transformed form here,
    // and neither is read, so a transform anywhere else is left out rather
    // than parsed as if it were the plain table.
    if (entry.nullTransform) tables.set(entry.tag, stream.subarray(at, at + entry.length));
    at += entry.length;
  }
  if (at !== stream.length) {
    throw new Error('the table lengths do not add up to the decompressed size');
  }
  return tables;
}

function table(tables: Map<string, Buffer>, tag: string): Buffer {
  const found = tables.get(tag);
  if (found === undefined) throw new Error(`the font has no ${tag} table`);
  return found;
}

// Code point to glyph id, from the first format 4 or format 12 subtable.
function characterMap(cmap: Buffer): Map<number, number> {
  const numTables = cmap.readUInt16BE(2);
  const offsets: number[] = [];
  for (let index = 0; index < numTables; index++) {
    offsets.push(cmap.readUInt32BE(8 + index * 8));
  }
  const mapped = new Map<number, number>();
  for (const offset of offsets) {
    const format = cmap.readUInt16BE(offset);
    if (format === 4) {
      const segments = cmap.readUInt16BE(offset + 6) / 2;
      const ends = offset + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const ranges = deltas + segments * 2;
      for (let segment = 0; segment < segments; segment++) {
        const end = cmap.readUInt16BE(ends + segment * 2);
        const start = cmap.readUInt16BE(starts + segment * 2);
        const delta = cmap.readInt16BE(deltas + segment * 2);
        const rangeOffset = cmap.readUInt16BE(ranges + segment * 2);
        for (let point = start; point <= end && point !== 0xffff; point++) {
          let glyph: number;
          if (rangeOffset === 0) {
            glyph = (point + delta) & 0xffff;
          } else {
            const at = ranges + segment * 2 + rangeOffset + (point - start) * 2;
            const read = cmap.readUInt16BE(at);
            glyph = read === 0 ? 0 : (read + delta) & 0xffff;
          }
          if (glyph !== 0) mapped.set(point, glyph);
        }
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(offset + 12);
      for (let group = 0; group < groups; group++) {
        const at = offset + 16 + group * 12;
        const start = cmap.readUInt32BE(at);
        const end = cmap.readUInt32BE(at + 4);
        const glyph = cmap.readUInt32BE(at + 8);
        for (let point = start; point <= end; point++) {
          mapped.set(point, glyph + (point - start));
        }
      }
    }
  }
  if (mapped.size === 0) throw new Error('the cmap table maps nothing');
  return mapped;
}

// The name records, keyed by name id. Windows records are UTF-16BE; the
// Macintosh ones the subsetter keeps are ASCII.
function nameRecords(name: Buffer): Map<number, string> {
  const count = name.readUInt16BE(2);
  const stringOffset = name.readUInt16BE(4);
  const records = new Map<number, string>();
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 12;
    const platform = name.readUInt16BE(at);
    const nameId = name.readUInt16BE(at + 6);
    const length = name.readUInt16BE(at + 8);
    const offset = stringOffset + name.readUInt16BE(at + 10);
    const bytes = name.subarray(offset, offset + length);
    // Windows records are UTF-16BE; the Macintosh ones kept here are ASCII.
    // The bytes are copied before swapping, so reading does not change the
    // table underneath.
    const text =
      platform === 1 ? bytes.toString('latin1') : Buffer.from(bytes).swap16().toString('utf16le');
    if (!records.has(nameId) || platform === 3) records.set(nameId, text);
  }
  return records;
}

// Advance width per glyph as a fraction of the em. A monospaced face can
// store one metric for every glyph, so anything past the last record repeats
// it, the way the hmtx table is defined.
function advanceWidth(tables: Map<string, Buffer>, glyph: number): number {
  const unitsPerEm = table(tables, 'head').readUInt16BE(18);
  const records = table(tables, 'hhea').readUInt16BE(34);
  const hmtx = table(tables, 'hmtx');
  if (records === 0) throw new Error('the font stores no advance widths');
  const record = Math.min(glyph, records - 1);
  return hmtx.readUInt16BE(record * 4) / unitsPerEm;
}

const subset = readFileSync(SUBSET);
const tables = sfntTables(subset);

// The stylesheet. One @font-face block, read as declarations so a reordered
// or reformatted file still passes.

function fontFace(css: string): Map<string, string> {
  const blocks = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)];
  expect(blocks, 'the stylesheet declares one @font-face').toHaveLength(1);
  const body = blocks[0]?.[1] ?? '';
  const declarations = new Map<string, string>();
  for (const line of body.split(';')) {
    const match = /^\s*([\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      declarations.set(match[1], match[2].replace(/\s+/g, ' '));
    }
  }
  return declarations;
}

const face = fontFace(readFileSync(FONTS_CSS, 'utf8'));

function declaration(property: string): string {
  const value = face.get(property);
  if (value === undefined) throw new Error(`the @font-face has no ${property}`);
  return value;
}

test('unicode-range is exactly U+20A6, U+20B5, U+20B1, U+20B9', () => {
  const entries = declaration('unicode-range')
    .split(',')
    .map((entry) => entry.trim());
  // Every entry is one code point written in full: a range or a wildcard
  // would let other characters through.
  for (const entry of entries) expect(entry).toMatch(/^U\+[0-9A-F]{4,6}$/);
  const points = entries.map((entry) => Number.parseInt(entry.slice(2), 16));
  expect([...points].sort((a, b) => a - b)).toEqual(SIGNS);
});

test('subset file is under 10 KB', () => {
  const bytes = statSync(SUBSET).size;
  expect(bytes).toBeGreaterThan(0);
  expect(bytes, `the subset is ${String(bytes)} bytes`).toBeLessThan(SIZE_BUDGET);
});

test('the subset draws the four signs and nothing else', () => {
  const mapped = characterMap(table(tables, 'cmap'));
  expect([...mapped.keys()].sort((a, b) => a - b)).toEqual(SIGNS);
});

test('every sign keeps the mono advance width', () => {
  const mapped = characterMap(table(tables, 'cmap'));
  for (const sign of SIGNS) {
    const glyph = mapped.get(sign);
    const where = `U+${sign.toString(16).toUpperCase()}`;
    expect(glyph, `${where} is missing`).toBeDefined();
    expect(advanceWidth(tables, glyph ?? 0), where).toBe(MONO_ADVANCE);
  }
});

test('the subset is Noto Sans Mono under the Open Font License', () => {
  const names = nameRecords(table(tables, 'name'));
  expect(names.get(1)).toBe(fonts.mono.signs.face);
  expect(names.get(0)).toContain('The Noto Project Authors');
  expect(names.get(13)).toContain('SIL Open Font License, Version 1.1');
  expect(names.get(14)).toBe('https://scripts.sil.org/OFL');
});

test('the font folder ships the licence text with the same copyright', () => {
  expect(existsSync(LICENSE), 'fonts/OFL.txt is missing').toBe(true);
  const text = readFileSync(LICENSE, 'utf8');
  const names = nameRecords(table(tables, 'name'));
  expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
  expect(text).toContain(names.get(0) ?? 'no copyright in the font');
});

test('the stylesheet loads the committed subset as woff2', () => {
  expect(declaration('font-family')).toBe(`'${fonts.mono.signs.face}'`);
  const source = declaration('src');
  const url = /url\('([^']+)'\)\s*format\('woff2'\)/.exec(source)?.[1];
  expect(url, `src is ${source}`).toBeDefined();
  expect(join(PACKAGE_ROOT, 'styles', url ?? '')).toBe(SUBSET);
  // Text stays visible while a sign is fetched.
  expect(declaration('font-display')).toBe('swap');
});

// Families in a font stack, split on the commas between them and not on the
// one inside var(--name, fallback).
function familyList(stack: string): string[] {
  const families: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of stack) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      families.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  families.push(current.trim());
  return families;
}

test('the second mono face follows the brand mono face in the stack', () => {
  const families = familyList(fonts.mono.stack);
  expect(families[0]).toContain(fonts.mono.variable);
  expect(families[1]).toBe(`'${fonts.mono.signs.face}'`);
  // The generic fallbacks stay last, so the brand faces always win.
  expect(families.slice(2)).toEqual([...fonts.mono.fallback]);
});
