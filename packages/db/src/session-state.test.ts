// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { describe, expect, it } from 'vitest';

import { SessionStateError } from './errors.js';
import {
  assertNoSessionState,
  holdsSessionState,
  setConfigArguments,
  stripLiteralsAndComments,
} from './session-state.js';

describe('session state guard', () => {
  it.each([
    'set ujira.principal_id = $1',
    "SET ujira.principal_id TO 'x'",
    'set session ujira.scope = 1',
    'SET LOCAL ujira.principal_id = 1',
    'reset ujira.principal_id',
    'RESET ALL',
    "select set_config('ujira.principal_id', $1, false)",
    "select set_config('ujira.principal_id', $1, FALSE)",
    "select set_config('ujira.principal_id', $1, 'f')",
    'set role app',
    'SET ROLE NONE',
    'set session authorization app',
    'discard all',
    "alter role app set statement_timeout = '1s'",
    "alter database postgres set statement_timeout = '1s'",
    'set search_path = public',
    'set time zone utc',
    "set_config('ujira.principal_id', $1, false)",
  ])('refuses %s', (sql) => {
    expect(holdsSessionState(sql)).toBe(true);
    expect(() => {
      assertNoSessionState(sql);
    }).toThrow(SessionStateError);
  });

  it('refuses it whatever the spacing, case or comments around it', () => {
    for (const sql of [
      '  \n\t set   ujira.principal_id = 1',
      '/* comment */ set ujira.principal_id = 1',
      '-- leading line comment\nset ujira.principal_id = 1',
      'SeT uJiRa.principal_id = 1',
      "select 1; set ujira.principal_id = 'x'",
      "select set_config('ujira.principal_id',\n  $1,\n  false\n)",
    ]) {
      expect(holdsSessionState(sql), sql).toBe(true);
    }
  });

  it.each([
    'select 1',
    'select * from payout where id = $1',
    "select set_config('ujira.principal_id', $1, true)",
    "select set_config('ujira.principal_id', $1, TRUE)",
    "select set_config('ujira.txid', txid_current()::text, true)",
    'begin',
    'commit',
    'rollback',
    // Words that merely contain the banned ones.
    'select offset_reset from job',
    'select * from settings',
    "insert into audit (action) values ('reset')",
    "select 'set role app' as example",
  ])('allows %s', (sql) => {
    expect(holdsSessionState(sql)).toBe(false);
    expect(() => {
      assertNoSessionState(sql);
    }).not.toThrow();
  });

  it('names what it refused without quoting the statement', () => {
    let message = '';
    try {
      assertNoSessionState("set ujira.principal_id = 'p'");
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('session level');
    expect(message).not.toContain('ujira.principal_id');
  });

  it('treats a string literal holding a banned word as text, not as state', () => {
    // A literal cannot change session state, and refusing it would stop
    // legitimate writes such as an audit row that records the word.
    expect(holdsSessionState("insert into audit (sql) values ('set role app')")).toBe(false);
    // But a real statement after a literal is still caught.
    expect(holdsSessionState("insert into audit (sql) values ('x'); set role app")).toBe(true);
  });

  it('reads a quoted argument whatever is inside it', () => {
    // These exercise the literal reader: a doubled quote, a backslash
    // escape, a double quoted identifier and an unterminated literal, each
    // of which could otherwise end a scan in the wrong place.
    expect(holdsSessionState("select set_config('ujira.x', 'it''s fine', true)")).toBe(false);
    expect(holdsSessionState("select set_config('ujira.x', 'a\\'b', true)")).toBe(false);
    expect(holdsSessionState('select set_config("ujira.x", \'v\', true)')).toBe(false);
    expect(holdsSessionState("select set_config('ujira.x', 'unterminated")).toBe(true);
    // A doubled quote inside the third argument still has to be a local flag.
    expect(holdsSessionState("select set_config('ujira.x', 'v', 'f''alse')")).toBe(true);
  });

  it('counts the arguments, so a call with the wrong shape is refused', () => {
    expect(setConfigArguments("select set_config('a', 'b', true)")).toEqual([
      ["'a'", "'b'", 'true'],
    ]);
    expect(holdsSessionState("select set_config('ujira.x', 'v')")).toBe(true);
    expect(holdsSessionState('select set_config()')).toBe(true);
    // Two calls, one of them session scoped.
    expect(
      holdsSessionState(
        "select set_config('ujira.a', 'v', true), set_config('ujira.b', 'v', false)",
      ),
    ).toBe(true);
  });

  it('strips a nested block comment without losing what follows', () => {
    expect(stripLiteralsAndComments('/* a /* b */ c */ set x = 1')).toContain('set x = 1');
    expect(holdsSessionState('/* a /* b */ c */ set ujira.principal_id = 1')).toBe(true);
    // An unterminated comment runs to the end, as Postgres reads it.
    expect(holdsSessionState('/* unterminated set ujira.principal_id = 1')).toBe(false);
  });

  it('refuses a set hidden behind a dollar quoted body', () => {
    const sql = '$$ set ujira.principal_id = 1 $$';
    // Inside a dollar quoted string it is text, so the guard allows it, and
    // the function that would execute it is reviewed like any other DDL.
    expect(holdsSessionState(sql)).toBe(false);
  });
});
