// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The setup and verify scripts over a ledger and key store in memory.

import { createMemoryAccountLedger } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { parseOptions, run } from './setup-accounts.ts';
import type { TestnetDeps } from './testnet.ts';
import { verify } from './verify-accounts.ts';

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

function world(passphrase = TESTNET_PASSPHRASE) {
  const ledger = createMemoryAccountLedger();
  const known = new Set<string>();
  const lines: string[] = [];
  const deps: TestnetDeps = {
    keys: {
      ensure: (name) => {
        known.add(name);
        return Promise.resolve(ledger.key(name));
      },
      publicKey: (name) => Promise.resolve(known.has(name) ? ledger.key(name) : null),
      sign: (name, txXdr) => ledger.sign(name, txXdr),
    },
    rpcPassphrase: () => Promise.resolve(passphrase),
    rpc: ledger.rpc,
    fund: ledger.fund,
    nowSeconds: () => 1_800_000_000,
    wait: { attempts: 2, intervalMs: 0, sleep: () => Promise.resolve() },
    write: (line) => {
      lines.push(line);
    },
  };
  return { ledger, deps, lines };
}

const options = (argv: readonly string[]) => parseOptions(['--channels', '2', ...argv]);

describe('setup-accounts.test.ts', () => {
  it('sets up two channels and the fee sponsor, and prints what to record', async () => {
    const w = world();
    expect(await run(options(['--network', 'stellar:testnet']), w.deps)).toBe(0);
    const output = JSON.parse(w.lines.at(-1) ?? '{}') as {
      accounts: { role: string; created: boolean }[];
      configuration: { executor: { keys: unknown[] }; feeSponsor: unknown };
      signingKeys: { purpose: string; keyRef: string }[];
    };
    expect(output.accounts.map((account) => [account.role, account.created])).toEqual([
      ['channel-1', true],
      ['channel-2', true],
      ['fee-sponsor', true],
    ]);
    expect(output.configuration.executor.keys).toHaveLength(2);
    expect(output.signingKeys.map((key) => key.purpose)).toEqual([
      'executor',
      'executor',
      'fee_sponsor',
    ]);
    expect(w.lines.join('\n')).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    expect(await verify(options(['--network', 'stellar:testnet']), w.deps)).toBe(0);
  });

  it('second run makes no changes', async () => {
    const w = world();
    await run(options(['--network', 'stellar:testnet']), w.deps);
    const sent = w.ledger.sent.length;
    expect(await run(options(['--network', 'stellar:testnet']), w.deps)).toBe(0);
    expect(w.ledger.sent).toHaveLength(sent);
    const output = JSON.parse(w.lines.at(-1) ?? '{}') as { accounts: { changes: string[] }[] };
    expect(output.accounts.every((account) => account.changes.length === 0)).toBe(true);
  });

  it('stellar:pubnet exits with an error', async () => {
    const w = world();
    expect(await run(options(['--network', 'stellar:pubnet']), w.deps)).toBe(1);
    expect(await verify(options(['--network', 'stellar:pubnet']), w.deps)).toBe(1);
    expect(w.ledger.sent).toEqual([]);
    expect(w.lines.every((line) => line.startsWith('refused'))).toBe(true);
  });

  it('refuses an RPC that is not testnet, whatever the network asked for', async () => {
    const w = world('Public Global Stellar Network ; September 2015');
    expect(await run(options(['--network', 'stellar:testnet']), w.deps)).toBe(1);
    expect(w.ledger.sent).toEqual([]);
  });

  it('fails the check for an account not set up, or a key it does not have', async () => {
    const w = world();
    expect(await verify(options(['--network', 'stellar:testnet']), w.deps)).toBe(1);
    expect(w.lines[0]).toBe('ujira-testnet-recovery: no such key');
  });

  it('refuses a channel count it cannot use', () => {
    expect(() => parseOptions(['--channels', '0'])).toThrow();
    expect(() => parseOptions(['--channels', 'two'])).toThrow();
  });
});
