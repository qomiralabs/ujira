// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The setup and check of the channel and fee sponsor accounts, over a ledger in
// memory that checks signatures against the thresholds as the network does.

import { xdr } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import { createMemoryAccountLedger } from '../testing/account-ledger.js';

import {
  ACCOUNT_LAYOUT,
  assertTestnet,
  buildLayoutTransaction,
  resultCodeOf,
  setUpAccounts,
  verifyAccounts,
} from './account-setup.js';

const OPTS = { correlationId: 'test' };
const NETWORK = 'stellar:testnet';
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

function world() {
  const ledger = createMemoryAccountLedger();
  const want = { managed: ledger.key('channel-1-managed'), recovery: ledger.key('recovery') };
  const accounts = [{ role: 'channel-1', keyName: 'channel-1', address: ledger.key('channel-1') }];
  const ports = {
    rpc: ledger.rpc,
    fund: ledger.fund,
    sign: ledger.sign,
    nowSeconds: () => 1_800_000_000,
    wait: { attempts: 2, intervalMs: 0, sleep: () => Promise.resolve() },
  };
  const request = { network: NETWORK, accounts, want, recoveryKeyName: 'recovery' };
  return { ledger, want, accounts, ports, request };
}

describe('account-setup.test.ts', () => {
  it('creates the account and puts the layout in place', async () => {
    const w = world();
    const [report] = await setUpAccounts(w.request, w.ports, OPTS);
    expect(report).toMatchObject({ role: 'channel-1', created: true });
    expect(report?.changes.length).toBeGreaterThan(0);
    const held = w.ledger.account(w.accounts[0]?.address ?? '');
    expect(held).toMatchObject({ masterWeight: 0, low: 1, medium: 1, high: 2 });
    expect([...(held?.signers ?? [])]).toEqual([
      [w.want.managed, ACCOUNT_LAYOUT.managedWeight],
      [w.want.recovery, ACCOUNT_LAYOUT.recoveryWeight],
    ]);
  });

  it('makes no change on a second run', async () => {
    const w = world();
    await setUpAccounts(w.request, w.ports, OPTS);
    const sent = w.ledger.sent.length;
    const [again] = await setUpAccounts(w.request, w.ports, OPTS);
    expect(again).toMatchObject({ created: false, changes: [], txHash: null });
    expect(w.ledger.sent).toHaveLength(sent);
  });

  it('fixes drift with the recovery signer once the master key is off', async () => {
    const w = world();
    await setUpAccounts(w.request, w.ports, OPTS);
    const replaced = { ...w.request, want: { ...w.want, managed: w.ledger.key('new-managed') } };
    const [report] = await setUpAccounts(replaced, w.ports, OPTS);
    expect(report?.changes).toEqual([
      'managed signer weight 0 to 1',
      'remove another signer of weight 1',
    ]);
    const held = w.ledger.account(w.accounts[0]?.address ?? '');
    expect([...(held?.signers.keys() ?? [])]).toEqual([w.want.recovery, replaced.want.managed]);
  });

  it('a managed key alone cannot change signers', async () => {
    const w = world();
    await setUpAccounts(w.request, w.ports, OPTS);
    const address = w.accounts[0]?.address ?? '';
    const held = w.ledger.account(address);
    const built = buildLayoutTransaction({
      network: NETWORK,
      account: address,
      accountSequence: held?.sequence ?? 0n,
      state: {
        masterWeight: 0,
        low: 1,
        medium: 1,
        high: 2,
        signers: [
          { key: w.want.managed, weight: 1 },
          { key: w.want.recovery, weight: 2 },
        ],
      },
      want: { ...w.want, managed: w.ledger.key('intruder') },
      nowSeconds: 1_800_000_000,
    });
    const signed = await w.ledger.sign('channel-1-managed', built.xdr);
    // Its weight meets the low threshold, so the network takes the transaction
    // and fails the operation, which needs the high one.
    const sent = await w.ledger.rpc.sendTransaction(signed, OPTS);
    expect(sent.status).toBe('PENDING');
    const landed = await w.ledger.rpc.getTransaction(sent.hash, OPTS);
    expect(landed.status).toBe('FAILED');
    expect(resultCodeOf(landed.resultXdr)).toBe('op_bad_auth');
    expect(w.ledger.account(address)?.signers.has(w.want.managed)).toBe(true);
  });

  it('reports what differs and nothing for an account in the layout', async () => {
    const w = world();
    const before = await verifyAccounts(w.request, w.ledger.rpc, OPTS);
    expect(before[0]?.problems).toEqual(['account does not exist']);
    await setUpAccounts(w.request, w.ports, OPTS);
    const after = await verifyAccounts(w.request, w.ledger.rpc, OPTS);
    expect(after[0]?.problems).toEqual([]);
    const other = await verifyAccounts(
      { ...w.request, want: { ...w.want, recovery: w.ledger.key('someone-else') } },
      w.ledger.rpc,
      OPTS,
    );
    expect(other[0]?.problems).toContain('recovery signer weight 0 to 2');
  });

  it('refuses any network but testnet, by id and by what the RPC says', async () => {
    expect(() => assertTestnet('stellar:pubnet')).toThrow(InvalidInputError);
    expect(() => assertTestnet(NETWORK, 'Public Global Stellar Network ; September 2015')).toThrow(
      InvalidInputError,
    );
    expect(assertTestnet(NETWORK, TESTNET_PASSPHRASE)).toBe(NETWORK);
    const w = world();
    await expect(
      setUpAccounts({ ...w.request, network: 'stellar:pubnet' }, w.ports, OPTS),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(w.ledger.sent).toEqual([]);
  });

  it('says which result the network refused with, and never a key', async () => {
    const w = world();
    await setUpAccounts(w.request, w.ports, OPTS);
    const broken = { ...w.ports, sign: (_name: string, txXdr: string) => Promise.resolve(txXdr) };
    const replaced = { ...w.request, want: { ...w.want, managed: w.ledger.key('another') } };
    const error = await setUpAccounts(replaced, broken, OPTS).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as InvalidInputError).issues).toEqual(['transaction (tx_bad_auth)']);
    expect(resultCodeOf(undefined)).toBe('unknown');
    expect(resultCodeOf('not xdr')).toBe('unreadable');
    const failedInside = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString('200'),
      result: xdr.TransactionResultResult.txFailed([
        xdr.OperationResult.opInner(
          xdr.OperationResultTr.setOptions(xdr.SetOptionsResult.setOptionsSuccess()),
        ),
        xdr.OperationResult.opInner(
          xdr.OperationResultTr.setOptions(xdr.SetOptionsResult.setOptionsTooManySigners()),
        ),
      ]),
      ext: new xdr.TransactionResultExt(0),
    }).toXDR('base64');
    expect(resultCodeOf(failedInside)).toBe('set_options_too_many_signers');
  });
});
