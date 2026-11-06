// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Reads every channel account and the fee sponsor on Stellar testnet and fails if
// the master weight, signers or thresholds differ from the layout. Reads public
// keys only, so it never needs a secret.
//
// Usage:
//   node scripts/stellar/verify-accounts.ts --network stellar:testnet [--channels 2]
//     [--rpc <url>] [--config-dir <dir>]

import { assertTestnet, verifyAccounts } from '@ujira/chain-adapter/stellar';

import { parseOptions, type Options } from './setup-accounts.ts';
import {
  NETWORK,
  plannedAccounts,
  RECOVERY_KEY,
  testnetDeps,
  type TestnetDeps,
} from './testnet.ts';

const OPTS = { correlationId: 'verify-accounts' };

/** Exit code 0 when every account is in the layout, 1 otherwise. */
export async function verify(options: Options, deps: TestnetDeps): Promise<number> {
  try {
    assertTestnet(options.network);
    assertTestnet(options.network, await deps.rpcPassphrase());
  } catch {
    deps.write(`refused: this checks ${NETWORK} accounts only, and the RPC must answer as it`);
    return 1;
  }
  const recovery = await deps.keys.publicKey(RECOVERY_KEY);
  let failed = recovery === null;
  if (recovery === null) deps.write(`${RECOVERY_KEY}: no such key`);
  for (const plan of plannedAccounts(options.channels)) {
    const address = await deps.keys.publicKey(plan.accountKey);
    const managed = await deps.keys.publicKey(plan.managedKey);
    if (address === null || managed === null || recovery === null) {
      deps.write(`${plan.role}: no key for the account or its managed signer`);
      failed = true;
      continue;
    }
    const [result] = await verifyAccounts(
      {
        network: NETWORK,
        accounts: [{ role: plan.role, address }],
        want: { managed, recovery },
      },
      deps.rpc,
      OPTS,
    );
    const problems = result?.problems ?? ['not read'];
    deps.write(`${plan.role} ${address}: ${problems.length === 0 ? 'ok' : problems.join('; ')}`);
    if (problems.length > 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const options = parseOptions(process.argv.slice(2));
  process.exitCode = await verify(options, testnetDeps(options.rpc, options.configDir));
}
