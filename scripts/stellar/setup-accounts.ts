// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Creates the executor channel accounts and the fee sponsor on Stellar testnet and
// holds each to the signer layout: master key off, a managed signer that can pay
// and call contracts, and a recovery signer that alone can change signers. Rerun
// it to fix drift; an account already in the layout is left alone.
//
// Prints the configuration entries and the signing key rows to record, as JSON.
// Never a key.
//
// Usage:
//   node scripts/stellar/setup-accounts.ts --network stellar:testnet [--channels 2]
//     [--rpc <url>] [--config-dir <dir>]

import { parseArgs } from 'node:util';

import { assertTestnet, setUpAccounts } from '@ujira/chain-adapter/stellar';
import type { AccountReport } from '@ujira/chain-adapter/stellar';

import {
  DEFAULT_CONFIG_DIR,
  DEFAULT_RPC_URL,
  KEY_PROVIDER,
  NETWORK,
  plannedAccounts,
  RECOVERY_KEY,
  testnetDeps,
  type AccountPlan,
  type TestnetDeps,
} from './testnet.ts';

const OPTS = { correlationId: 'setup-accounts' };
const MAX_CHANNELS = 32;

export interface Options {
  readonly network: string;
  readonly channels: number;
  readonly rpc: string;
  readonly configDir: string;
}

export function parseOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      network: { type: 'string' },
      channels: { type: 'string', default: '2' },
      rpc: { type: 'string', default: DEFAULT_RPC_URL },
      'config-dir': { type: 'string', default: DEFAULT_CONFIG_DIR },
    },
  });
  const channels = Number(values.channels);
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_CHANNELS) {
    throw new Error(`--channels must be a whole number from 1 to ${String(MAX_CHANNELS)}`);
  }
  return {
    network: values.network ?? '',
    channels,
    rpc: values.rpc,
    configDir: values['config-dir'],
  };
}

/** Exit code 0 when every account is in the layout, 1 otherwise. */
export async function run(options: Options, deps: TestnetDeps): Promise<number> {
  try {
    assertTestnet(options.network);
    assertTestnet(options.network, await deps.rpcPassphrase());
  } catch {
    deps.write(`refused: this sets up ${NETWORK} accounts only, and the RPC must answer as it`);
    return 1;
  }
  const recovery = await deps.keys.ensure(RECOVERY_KEY);
  const reports: AccountReport[] = [];
  const entries: { plan: AccountPlan; address: string; managed: string }[] = [];
  for (const plan of plannedAccounts(options.channels)) {
    const address = await deps.keys.ensure(plan.accountKey);
    const managed = await deps.keys.ensure(plan.managedKey);
    const [report] = await setUpAccounts(
      {
        network: NETWORK,
        accounts: [{ role: plan.role, keyName: plan.accountKey, address }],
        want: { managed, recovery },
        recoveryKeyName: RECOVERY_KEY,
      },
      {
        rpc: deps.rpc,
        fund: deps.fund,
        sign: (name, txXdr) => deps.keys.sign(name, txXdr),
        nowSeconds: deps.nowSeconds,
        wait: deps.wait,
      },
      OPTS,
    );
    if (report !== undefined) reports.push(report);
    entries.push({ plan, address, managed });
  }
  const keyRef = (entry: (typeof entries)[number]) => ({
    provider: KEY_PROVIDER,
    keyId: entry.plan.managedKey,
    address: entry.address,
  });
  const sponsor = entries.find((entry) => entry.plan.purpose === 'fee_sponsor');
  deps.write(
    JSON.stringify(
      {
        network: NETWORK,
        accounts: reports,
        configuration: {
          executor: {
            keys: entries.filter((entry) => entry.plan.purpose === 'executor').map(keyRef),
          },
          feeSponsor: sponsor === undefined ? null : { key: keyRef(sponsor) },
        },
        signingKeys: entries.map((entry) => ({
          purpose: entry.plan.purpose,
          network: NETWORK,
          provider: KEY_PROVIDER,
          keyRef: entry.plan.managedKey,
          address: entry.address,
        })),
      },
      null,
      2,
    ),
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const options = parseOptions(process.argv.slice(2));
  process.exitCode = await run(options, testnetDeps(options.rpc, options.configDir));
}
