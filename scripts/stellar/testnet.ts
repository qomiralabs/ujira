// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the testnet account scripts share: the accounts and keys they name, and
// the ports they reach the network and the stellar CLI's key store through.
//
// Keys stay in the CLI's store, outside every repository. A secret is read only
// to sign, held for that one call, checked against the public key it should
// belong to, and never printed or written anywhere.

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AccountSetupPorts } from '@ujira/chain-adapter/stellar';
import {
  createStellarRpc,
  publicKeyOfSecret,
  signTestnetTransaction,
} from '@ujira/chain-adapter/stellar';

export const NETWORK = 'stellar:testnet';
export const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
export const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'ujira-testnet', 'stellar');
const FRIENDBOT = 'https://friendbot.stellar.org/';
const CALL_TIMEOUT_MS = 30_000;
// The key store's provider in the configuration's key references, for testnet.
export const KEY_PROVIDER = 'stellar_cli';
export const RECOVERY_KEY = 'ujira-testnet-recovery';

export interface AccountPlan {
  /** channel-1 to channel-N, and fee-sponsor. */
  readonly role: string;
  readonly purpose: 'executor' | 'fee_sponsor';
  /** The account's own key, which signs until its master weight is 0. */
  readonly accountKey: string;
  /** The managed signer for this account, the key the signer service holds. */
  readonly managedKey: string;
}

export function plannedAccounts(channels: number): readonly AccountPlan[] {
  const roles = [
    ...Array.from({ length: channels }, (_unused, index) => ({
      role: `channel-${String(index + 1)}`,
      purpose: 'executor' as const,
    })),
    { role: 'fee-sponsor', purpose: 'fee_sponsor' as const },
  ];
  return roles.map(({ role, purpose }) => ({
    role,
    purpose,
    accountKey: `ujira-testnet-${role}`,
    managedKey: `ujira-testnet-${role}-managed`,
  }));
}

export interface KeyStore {
  /** The key's public key, made on first use. */
  ensure(name: string): Promise<string>;
  /** The key's public key, or null when the store has no such key. */
  publicKey(name: string): Promise<string | null>;
  /** Signs with the key, without the secret leaving this call. */
  sign(name: string, txXdr: string): Promise<string>;
}

export interface TestnetDeps {
  readonly keys: KeyStore;
  /** What the RPC says its network passphrase is. */
  readonly rpcPassphrase: () => Promise<string>;
  readonly rpc: AccountSetupPorts['rpc'];
  readonly fund: AccountSetupPorts['fund'];
  readonly nowSeconds: () => number;
  readonly wait: AccountSetupPorts['wait'];
  /** Where results go, one line at a time. Never handed a key. */
  readonly write: (line: string) => void;
}

function cli(configDir: string, args: readonly string[]): string {
  return execFileSync('stellar', [...args, '--config-dir', configDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CALL_TIMEOUT_MS,
  }).trim();
}

export function cliKeyStore(configDir: string): KeyStore {
  const publicKey = (name: string): Promise<string | null> => {
    try {
      return Promise.resolve(cli(configDir, ['keys', 'public-key', name]));
    } catch {
      return Promise.resolve(null);
    }
  };
  return {
    publicKey,
    async ensure(name) {
      const known = await publicKey(name);
      if (known !== null) return known;
      cli(configDir, ['keys', 'generate', name]);
      const made = await publicKey(name);
      if (made === null) throw new Error(`the key store did not keep ${name}`);
      return made;
    },
    async sign(name, txXdr) {
      const expected = await publicKey(name);
      if (expected === null) throw new Error(`no key named ${name}`);
      const secret = cli(configDir, ['keys', 'secret', name]);
      if (publicKeyOfSecret(secret) !== expected) {
        throw new Error(`the secret stored as ${name} is not for its public key`);
      }
      return signTestnetTransaction(txXdr, secret);
    },
  };
}

export async function rpcPassphraseOf(url: string): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNetwork' }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const body = (await response.json()) as { result?: { passphrase?: unknown } };
  const passphrase = body.result?.passphrase;
  if (typeof passphrase !== 'string') throw new Error('the RPC did not say which network it is');
  return passphrase;
}

export async function friendbotFund(address: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(address)}`, {
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`friendbot answered ${String(response.status)}`);
}

export function testnetDeps(rpcUrl: string, configDir: string): TestnetDeps {
  return {
    keys: cliKeyStore(configDir),
    rpcPassphrase: () => rpcPassphraseOf(rpcUrl),
    rpc: createStellarRpc({ network: NETWORK, url: rpcUrl, timeoutMs: CALL_TIMEOUT_MS }),
    fund: friendbotFund,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    wait: {
      attempts: 30,
      intervalMs: 2_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}
