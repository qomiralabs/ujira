// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Finds characters that change how text reads without being visible in a
// review: every character in the Unicode categories Cf (format, including
// bidirectional controls, zero width characters and the byte order mark), Zl
// (line separator) and Zp (paragraph separator), plus the lookalike no break
// space, narrow no break space and minus sign. Categories come from the
// Unicode tables built into Node.js (`process.versions.unicode`), not from a
// hand written list, so new format characters are covered as Node updates.

export interface Finding {
  line: number;
  // In code points, counting from 1.
  column: number;
  codePoint: number;
}

export type Scan =
  | { kind: 'text'; findings: Finding[] }
  | { kind: 'binary' }
  | { kind: 'invalid' }
  | { kind: 'mismatch'; extension: string };

// A signature is the bytes a file must start with; null matches any byte.
export type Signature = readonly (number | null)[];
const ascii = (value: string): Signature => Array.from(Buffer.from(value, 'latin1'));
const ANY4: Signature = [null, null, null, null];

/**
 * The only binary file types the check skips, by extension, each with the
 * signatures its content must start with. Any other file is scanned as text,
 * so a NUL byte does not let a source file skip the check: it is reported
 * as U+0000. Add a type here only with a reason in review.
 */
export const BINARY_SIGNATURES: Readonly<Record<string, readonly Signature[]>> = {
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  gif: [ascii('GIF87a'), ascii('GIF89a')],
  // A RIFF container whose form type is WEBP.
  webp: [[...ascii('RIFF'), ...ANY4, ...ascii('WEBP')]],
  ico: [[0x00, 0x00, 0x01, 0x00]],
  woff: [ascii('wOFF')],
  woff2: [ascii('wOF2')],
  wasm: [[0x00, 0x61, 0x73, 0x6d]],
  pdf: [ascii('%PDF-')],
};

function matchesSignature(extension: string, data: Buffer): boolean {
  return (BINARY_SIGNATURES[extension] ?? []).some(
    (signature) =>
      data.length >= signature.length &&
      signature.every((byte, index) => byte === null || data[index] === byte),
  );
}

// Rejected everywhere.
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/u;
// Rejected unless the file is on the allowlist.
const LOOKALIKES = new Set([0x00a0, 0x202f, 0x2212]);
const CANDIDATES = /[\p{Cf}\p{Zl}\p{Zp}\u00A0\u202F\u2212\n\0]/gu;

/**
 * Scans one file's bytes. A file is skipped as binary only when its
 * extension is in BINARY_SIGNATURES and its content starts with a matching
 * signature; a listed extension with other content is a mismatch. Every
 * other file must be valid UTF-8 and is scanned in full, with a NUL byte
 * reported as U+0000. A byte order mark is kept so it is reported like any
 * other format character.
 */
export function findInvisibleCharacters(
  name: string,
  data: Buffer,
  allowLookalikes: boolean,
): Scan {
  const dot = name.lastIndexOf('.');
  const extension = dot > name.lastIndexOf('/') ? name.slice(dot + 1).toLowerCase() : '';
  if (Object.hasOwn(BINARY_SIGNATURES, extension)) {
    return matchesSignature(extension, data) ? { kind: 'binary' } : { kind: 'mismatch', extension };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return { kind: 'invalid' };
  }
  const findings: Finding[] = [];
  let line = 1;
  let lineStart = 0;
  for (const match of text.matchAll(CANDIDATES)) {
    const character = match[0];
    if (character === '\n') {
      line += 1;
      lineStart = match.index + 1;
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    const rejected =
      codePoint === 0 ||
      INVISIBLE.test(character) ||
      (!allowLookalikes && LOOKALIKES.has(codePoint));
    if (!rejected) continue;
    // Columns count code points, so a character outside the BMP counts once.
    const column = Array.from(text.slice(lineStart, match.index)).length + 1;
    findings.push({ line, column, codePoint });
  }
  return { kind: 'text', findings };
}

/** Repository relative paths, one per line, with `#` comments. */
export function parseAllowlist(text: string): Set<string> {
  const paths = new Set<string>();
  for (const raw of text.split('\n')) {
    const path = raw.replace(/#.*$/, '').trim();
    if (path !== '') paths.add(path);
  }
  return paths;
}

function isUnsafeInName(character: string): boolean {
  const point = character.codePointAt(0) ?? 0;
  return (
    point < 0x20 ||
    (point >= 0x7f && point <= 0x9f) ||
    INVISIBLE.test(character) ||
    character === '"' ||
    character === '\\'
  );
}

/**
 * A file name safe to print in a log: shown as it is when it is valid UTF-8
 * without control, format or separator characters, otherwise quoted with
 * every byte outside printable ASCII escaped.
 */
export function showPath(name: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(name);
    if (!Array.from(text).some(isUnsafeInName)) return text;
  } catch {
    // Not UTF-8: escaped below.
  }
  let shown = '';
  for (const byte of name) {
    const safe = byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c;
    shown += safe ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return `"${shown}"`;
}

export function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}
