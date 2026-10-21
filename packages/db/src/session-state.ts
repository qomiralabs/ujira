// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Session level state is banned on pooled connections. The Supabase spike
// measured a session level setting on one client being read by another
// client on the same backend, which is a tenant leak, and the transaction
// pooler hands the same backend to anyone. Everything this package runs is
// transaction local, so any statement that would outlive its transaction is
// refused before it is sent.
//
// This is a guard, not a parser. Statement forms are matched with string
// literals and comments removed, so a banned word inside a literal stays
// text and cannot trip it. Double quoted identifiers keep their text,
// because the identifier is what the patterns need to read after the
// keyword, and dollar quoted bodies are scanned rather than blanked,
// because such a body can be executed. set_config is read with literals
// kept, because its third argument decides the scope and is usually a
// literal.

import { SessionStateError } from './errors.js';

// Statement forms that change state beyond the current transaction. SET
// LOCAL is included: it is transaction local and so harmless, but context
// here travels through set_config, and a second spelling would be a second
// thing to keep right.
const BANNED: readonly RegExp[] = [
  /\bset\s+(?:session\s+authorization\b|session_authorization\b|session\b|local\b|role\b|time\s+zone\b|[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?\s*(?:=|\bto\b))/,
  /\breset\s+(?:all\b|[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)/,
  /\bdiscard\s+[a-z]+/,
  /\balter\s+(?:role|user|database)\b[\s\S]*?\bset\b/,
];

// Third arguments that make a set_config call transaction local. Anything
// else, a bind parameter included, is refused: the value of a parameter is
// not known here, and the local flag is what keeps a tenant out of the next
// transaction on the same backend.
const LOCAL_FLAGS: ReadonlySet<string> = new Set(['true', "'true'", "'t'", "'on'", "'yes'", "'1'"]);

interface Replace {
  readonly literals: boolean;
}

// Walks the SQL, replacing comments, and optionally string literals and
// dollar quoted bodies, with a space. An unterminated quote or comment runs
// to the end, as Postgres reads it, so nothing after one hides from a scan.
function blank(sql: string, { literals }: Replace): string {
  let out = '';
  let at = 0;
  while (at < sql.length) {
    const char = sql[at] ?? '';
    // A dollar quoted body is not inert. DO runs it, CREATE FUNCTION stores
    // it to run later, and code review proved a tenant key set inside one
    // survived the transaction. Nothing here can tell an executed body from
    // a string that merely looks like one, so the content is scanned and a
    // body holding a banned statement is refused. That refuses a literal
    // that only quotes such a statement too, which is the direction to err
    // in: a false refusal is a review conversation, a false pass is a
    // tenant leak.
    const dollar = /^\$([a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(at));
    if (dollar !== null) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, at + tag.length);
      const body = sql.slice(at + tag.length, close === -1 ? sql.length : close);
      at = close === -1 ? sql.length : close + tag.length;
      out += ` ${blank(body, { literals })} `;
      continue;
    }
    if (char === '-' && sql[at + 1] === '-') {
      const end = sql.indexOf('\n', at);
      at = end === -1 ? sql.length : end;
      out += ' ';
      continue;
    }
    if (char === '/' && sql[at + 1] === '*') {
      let depth = 1;
      at += 2;
      while (at < sql.length && depth > 0) {
        if (sql[at] === '/' && sql[at + 1] === '*') {
          depth += 1;
          at += 2;
        } else if (sql[at] === '*' && sql[at + 1] === '/') {
          depth -= 1;
          at += 2;
        } else {
          at += 1;
        }
      }
      out += ' ';
      continue;
    }
    // A double quote delimits an identifier, not a string, and the
    // identifier is what the patterns below need to read: `set
    // "ujira.principal_id" = ...` is a session level SET of a tenant key.
    // The quotes are dropped and the name is kept.
    if (char === '"') {
      at += 1;
      while (at < sql.length) {
        if (sql[at] === '"') {
          // Two in a row are an escaped quote inside the identifier.
          if (sql[at + 1] === '"') {
            out += '"';
            at += 2;
            continue;
          }
          at += 1;
          break;
        }
        out += sql[at] ?? '';
        at += 1;
      }
      continue;
    }
    if (literals && char === "'") {
      // Backslashes escape only in an E string. With
      // standard_conforming_strings on, which is the default, a plain
      // literal ends at its closing quote even if a backslash precedes it,
      // so treating one as an escape would run the scan past the end of the
      // statement and miss whatever follows.
      const escapes = /[eE]$/.test(out.trimEnd()) && /[^a-z0-9_$]?[eE]$/i.test(out);
      at += 1;
      while (at < sql.length) {
        if (sql[at] === "'") {
          if (sql[at + 1] === "'") {
            at += 2;
            continue;
          }
          at += 1;
          break;
        }
        if (escapes && sql[at] === '\\') {
          at += 2;
          continue;
        }
        at += 1;
      }
      out += ' ';
      continue;
    }
    out += char;
    at += 1;
  }
  return out;
}

export function stripLiteralsAndComments(sql: string): string {
  return blank(sql, { literals: true });
}

// Reads one quoted literal starting at `from`, returning it with its quotes.
function readQuoted(sql: string, from: number, escapes = false): { text: string; next: number } {
  const quote = sql[from] ?? "'";
  let text = quote;
  let at = from + 1;
  while (at < sql.length) {
    const char = sql[at] ?? '';
    text += char;
    if (char === quote) {
      if (sql[at + 1] === quote) {
        text += quote;
        at += 2;
        continue;
      }
      at += 1;
      break;
    }
    // Backslash escapes exist only in an E string; see blank() above.
    if (quote === "'" && char === '\\' && escapes) {
      text += sql[at + 1] ?? '';
      at += 2;
      continue;
    }
    at += 1;
  }
  return { text, next: at };
}

// The arguments of every set_config call in the statement, split at the top
// level so a nested call or a comma inside a literal stays with its argument.
export function setConfigArguments(sql: string): string[][] {
  const calls: string[][] = [];
  const pattern = /\bset_config\s*\(/giu;
  let match = pattern.exec(sql);
  while (match !== null) {
    let at = match.index + match[0].length;
    let depth = 1;
    let current = '';
    const args: string[] = [];
    while (at < sql.length && depth > 0) {
      const char = sql[at] ?? '';
      if (char === "'" || char === '"') {
        // An E immediately before the quote makes backslashes escape, which
        // changes where the literal ends. blank() applies the same rule.
        const escapes = char === "'" && /(?:^|[^a-z0-9_$])[eE]$/i.test(current.trimEnd());
        const quoted = readQuoted(sql, at, escapes);
        current += quoted.text;
        at = quoted.next;
        continue;
      }
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          at += 1;
          break;
        }
      } else if (char === ',' && depth === 1) {
        args.push(current.trim());
        current = '';
        at += 1;
        continue;
      }
      current += char;
      at += 1;
    }
    args.push(current.trim());
    calls.push(args);
    pattern.lastIndex = at;
    match = pattern.exec(sql);
  }
  return calls;
}

// True when any set_config call is not plainly transaction local.
function hasSessionScopedSetConfig(sql: string): boolean {
  return setConfigArguments(sql).some((args) => {
    if (args.length !== 3) return true;
    return !LOCAL_FLAGS.has((args[2] ?? '').toLowerCase());
  });
}

// True when the statement would change state that outlives its transaction.
export function holdsSessionState(sql: string): boolean {
  if (BANNED.some((pattern) => pattern.test(stripLiteralsAndComments(sql).toLowerCase()))) {
    return true;
  }
  return hasSessionScopedSetConfig(blank(sql, { literals: false }));
}

// Throws when the statement would change session state. The statement is
// not repeated in the message: it can carry a tenant identifier, and the
// caller knows what it passed.
export function assertNoSessionState(sql: string): void {
  if (holdsSessionState(sql)) {
    throw new SessionStateError(
      'refused: the statement changes session level state, which leaks across pooled connections; send transaction local context instead',
    );
  }
}
