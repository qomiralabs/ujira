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

export type Scan = { kind: 'text'; findings: Finding[] } | { kind: 'binary' } | { kind: 'invalid' };

// Rejected everywhere.
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/u;
// Rejected unless the file is on the allowlist.
const LOOKALIKES = new Set([0x00a0, 0x202f, 0x2212]);
const CANDIDATES = /[\p{Cf}\p{Zl}\p{Zp}\u00A0\u202F\u2212\n]/gu;

/**
 * Scans one file's bytes. Content with a NUL byte is binary, as git decides,
 * and is skipped whatever its name. Other content must be valid UTF-8; a byte
 * order mark is kept so it is reported like any other format character.
 */
export function findInvisibleCharacters(data: Buffer, allowLookalikes: boolean): Scan {
  if (data.includes(0)) return { kind: 'binary' };
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
    if (!INVISIBLE.test(character) && (allowLookalikes || !LOOKALIKES.has(codePoint))) continue;
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
