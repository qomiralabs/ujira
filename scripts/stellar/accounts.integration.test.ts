// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The signer layout on Stellar testnet itself, against accounts setup-accounts
// made. Skipped unless UJIRA_STELLAR_TESTNET=1, so CI and anyone without the
// testnet keys never reach the network. Keys come from the stellar CLI's store
// and stay in memory.

import {
  accountLedgerKey,
  accountSequenceOf,
  buildLayoutTransaction,
  readAccountLayout,
  resultCodeOf,
  verifyAccounts,
} from '@ujira/chain-adapter/stellar';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG_DIR,
  DEFAULT_RPC_URL,
  NETWORK,
  plannedAccounts,
  RECOVERY_KEY,
  testnetDeps,
} from './testnet.ts';

const OPTS = { correlationId: 'accounts-integration' };
const enabled = process.env['UJIRA_STELLAR_TESTNET'] === '1';

describe.skipIf(!enabled)('accounts.integration.test.ts', { timeout: 180_000 }, () => {
  const deps = testnetDeps(DEFAULT_RPC_URL, DEFAULT_CONFIG_DIR);
  const plan = plannedAccounts(1)[0];

  async function current() {
    if (plan === undefined) throw new Error('no account planned');
    const address = await deps.keys.publicKey(plan.accountKey);
    const managed = await deps.keys.publicKey(plan.managedKey);
    const recovery = await deps.keys.publicKey(RECOVERY_KEY);
    if (address === null || managed === null || recovery === null) {
      throw new Error('run setup-accounts first');
    }
    const { entries } = await deps.rpc.getLedgerEntries([accountLedgerKey(address)], OPTS);
    const entry = entries[0];
    if (entry === undefined) throw new Error('the account does not exist');
    return {
      address,
      managed,
      recovery,
      state: readAccountLayout(entry),
      sequence: accountSequenceOf(entry),
    };
  }

  async function send(signed: string) {
    const sent = await deps.rpc.sendTransaction(signed, OPTS);
    if (sent.status === 'ERROR')
      return { hash: sent.hash, code: resultCodeOf(sent.errorResultXdr) };
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const tx = await deps.rpc.getTransaction(sent.hash, OPTS);
      if (tx.status !== 'NOT_FOUND') {
        return {
          hash: sent.hash,
          code: tx.status === 'SUCCESS' ? 'tx_success' : resultCodeOf(tx.resultXdr),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error('the transaction did not land');
  }

  it('a SetOptions signed only by the managed key fails with op_bad_auth', async () => {
    const account = await current();
    if (plan === undefined) return;
    const intruder = await deps.keys.ensure('ujira-testnet-integration-intruder');
    const built = buildLayoutTransaction({
      network: NETWORK,
      account: account.address,
      accountSequence: account.sequence,
      state: account.state,
      want: { managed: intruder, recovery: account.recovery },
      nowSeconds: deps.nowSeconds(),
    });
    const result = await send(await deps.keys.sign(plan.managedKey, built.xdr));
    process.stdout.write(`managed only: ${result.hash} ${result.code}\n`);
    expect(result.code).toBe('op_bad_auth');
  });

  it('recovery signer replaces the managed signer, address unchanged', async () => {
    const before = await current();
    if (plan === undefined) return;
    const replacement = await deps.keys.ensure('ujira-testnet-integration-replacement');
    const rotate = buildLayoutTransaction({
      network: NETWORK,
      account: before.address,
      accountSequence: before.sequence,
      state: before.state,
      want: { managed: replacement, recovery: before.recovery },
      nowSeconds: deps.nowSeconds(),
    });
    expect(rotate.signer).toBe('recovery');
    const rotated = await send(await deps.keys.sign(RECOVERY_KEY, rotate.xdr));
    process.stdout.write(`rotate: ${rotated.hash} ${rotated.code}\n`);
    expect(rotated.code).toBe('tx_success');
    const [after] = await verifyAccounts(
      {
        network: NETWORK,
        accounts: [{ role: plan.role, address: before.address }],
        want: { managed: replacement, recovery: before.recovery },
      },
      deps.rpc,
      OPTS,
    );
    expect(after).toMatchObject({ account: before.address, problems: [] });
    // And back, so the account is left as setup-accounts made it.
    const middle = await current();
    const restore = buildLayoutTransaction({
      network: NETWORK,
      account: middle.address,
      accountSequence: middle.sequence,
      state: middle.state,
      want: { managed: before.managed, recovery: before.recovery },
      nowSeconds: deps.nowSeconds(),
    });
    const restored = await send(await deps.keys.sign(RECOVERY_KEY, restore.xdr));
    process.stdout.write(`restore: ${restored.hash} ${restored.code}\n`);
    expect(restored.code).toBe('tx_success');
  });
});
