// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The spike harness's own safety checks. These need no database, so they
// run everywhere, CI included.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connect, parsePoolerUrl, scramVerifier, spikeEnv } from './harness.js';

const VARIABLES = [
  'SUPABASE_SESSION_POOLER_URL',
  'SUPABASE_TRANSACTION_POOLER_URL',
  'SUPABASE_PROJECT_REF',
  'SUPABASE_SPIKE_REQUIRED',
] as const;

// A marker standing in for a password, to prove it never reaches a message.
const MARKER = ['not', 'a', 'real', 'secret'].join('_');

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('spike environment', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of VARIABLES) {
      saved.set(name, process.env[name]);
      Reflect.deleteProperty(process.env, name);
    }
  });

  afterEach(() => {
    for (const name of VARIABLES) {
      const value = saved.get(name);
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  });

  it('skips when nothing is set', () => {
    expect(spikeEnv()).toBeNull();
  });

  it('refuses a partial configuration and names what is missing', () => {
    process.env['SUPABASE_SESSION_POOLER_URL'] = `postgres://u:${MARKER}@host.example:5432/db`;
    process.env['SUPABASE_TRANSACTION_POOLER_URL'] = `postgres://u:${MARKER}@host.example:6543/db`;
    const err = thrown(() => spikeEnv()) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('SUPABASE_PROJECT_REF');
    expect(err.message).not.toContain(MARKER);
  });

  it('refuses to skip when the run is required', () => {
    process.env['SUPABASE_SPIKE_REQUIRED'] = '1';
    expect(thrown(() => spikeEnv())).toBeInstanceOf(Error);
  });

  it('returns all three values when they are set', () => {
    process.env['SUPABASE_SESSION_POOLER_URL'] = 'postgres://u:p@host.example:5432/db';
    process.env['SUPABASE_TRANSACTION_POOLER_URL'] = 'postgres://u:p@host.example:6543/db';
    process.env['SUPABASE_PROJECT_REF'] = 'ref';
    expect(spikeEnv()).toEqual({
      session: 'postgres://u:p@host.example:5432/db',
      transaction: 'postgres://u:p@host.example:6543/db',
      projectRef: 'ref',
    });
  });
});

describe('pooler URLs', () => {
  it.each([
    'sslmode=require',
    'sslmode=verify-full',
    'sslmode=no-verify',
    'sslmode=disable',
    'sslrootcert=/tmp/ca.crt',
    'sslcert=/tmp/c.crt',
    'sslkey=/tmp/c.key',
    'ssl=false',
    'SSLMODE=disable',
  ])('refuses %s, which would replace the pinned CA', (param) => {
    const err = thrown(() =>
      parsePoolerUrl(`postgres://u:${MARKER}@host.example:5432/db?${param}`),
    ) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('pinned CA');
    expect(err.message).not.toContain(MARKER);
  });

  it('never repeats an unparseable URL, password included', () => {
    const err = thrown(() => parsePoolerUrl(`postgres://u:${MARKER}@[bad`)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(MARKER);
    expect(JSON.stringify(err)).not.toContain(MARKER);
    expect('input' in err).toBe(false);
    expect(err.cause).toBeUndefined();
  });

  it('refuses another scheme', () => {
    expect(thrown(() => parsePoolerUrl('https://host.example/db'))).toBeInstanceOf(Error);
  });

  it('connect refuses TLS parameters before opening a socket', async () => {
    const started = Date.now();
    const err = await connect(`postgres://u:${MARKER}@127.0.0.1:9/db?sslmode=disable`).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('pinned CA');
    expect((err as Error).message).not.toContain(MARKER);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('SCRAM verifiers', () => {
  it('sends a fresh verifier, never the password', () => {
    const a = scramVerifier(MARKER);
    const b = scramVerifier(MARKER);
    expect(a).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(MARKER);
  });
});
