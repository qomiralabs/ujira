// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for operation details (codecs/operations.ts, read through
 * decodeTransactionEnvelope).
 *
 * Every decoded operation carries a detail: the contract, function and
 * argument count of a contract call; the sponsored account of a begin
 * sponsoring; the destination and starting balance of a create account;
 * the asset and limit of a change trust; the name and value of a manage
 * data; kind host_function for any other host function, end_sponsoring for
 * an end sponsoring, and kind other for everything else.
 */

import {
  Account,
  Asset,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';

import {
  TEST_CONTRACT,
  TEST_DESTINATION,
  TEST_INNER_SOURCE,
  testInvokeXdr,
  testReserveSandwichXdr,
  testSep10ChallengeXdr,
} from '../testing/stellar.js';
import { decodeTransactionEnvelope } from './index.js';

const NETWORK = 'stellar:testnet';
const ISSUER = 'GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC';

function details(text: string) {
  return decodeTransactionEnvelope(text, NETWORK).operations.map((op) => op.detail);
}

function single(operation: xdr.Operation): string {
  return new TransactionBuilder(new Account(TEST_INNER_SOURCE, '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(operation)
    .build()
    .toEnvelope()
    .toXDR('base64');
}

describe('operation details', () => {
  it('reads contract calls', () => {
    const text = testInvokeXdr({
      source: TEST_INNER_SOURCE,
      calls: [
        { contract: TEST_CONTRACT, functionName: 'execute' },
        { contract: TEST_CONTRACT, functionName: 'execute_batch' },
      ],
    });
    expect(details(text)).toEqual([
      { kind: 'invoke_contract', contract: TEST_CONTRACT, functionName: 'execute', argCount: 1 },
      {
        kind: 'invoke_contract',
        contract: TEST_CONTRACT,
        functionName: 'execute_batch',
        argCount: 1,
      },
    ]);
  });

  it('reads every step of a sponsorship sandwich', () => {
    const text = testReserveSandwichXdr({
      sponsor: TEST_INNER_SOURCE,
      sponsored: TEST_DESTINATION,
      asset: { code: 'USDC', issuer: ISSUER },
    });
    expect(details(text)).toEqual([
      { kind: 'begin_sponsoring', sponsoredId: TEST_DESTINATION },
      { kind: 'create_account', destination: TEST_DESTINATION, startingBalance: 0n },
      {
        kind: 'change_trust',
        asset: { kind: 'credit', code: 'USDC', issuer: ISSUER },
        limit: 9_223_372_036_854_775_807n,
      },
      { kind: 'end_sponsoring' },
    ]);
  });

  it('reads the trust line asset kinds', () => {
    const twelve = new Asset('LONGASSET123', ISSUER);
    expect(details(single(Operation.changeTrust({ asset: twelve, limit: '5' })))).toEqual([
      {
        kind: 'change_trust',
        asset: { kind: 'credit', code: 'LONGASSET123', issuer: ISSUER },
        limit: 50_000_000n,
      },
    ]);
    const pool = new xdr.ChangeTrustOp({
      line: xdr.ChangeTrustAsset.assetTypePoolShare(
        xdr.LiquidityPoolParameters.liquidityPoolConstantProduct(
          new xdr.LiquidityPoolConstantProductParameters({
            assetA: Asset.native().toXDRObject(),
            assetB: new Asset('USDC', ISSUER).toXDRObject(),
            fee: 30,
          }),
        ),
      ),
      limit: xdr.Int64.fromString('1'),
    });
    expect(
      details(
        single(
          new xdr.Operation({ sourceAccount: null, body: xdr.OperationBody.changeTrust(pool) }),
        ),
      ),
    ).toMatchObject([{ kind: 'change_trust', asset: { kind: 'pool_share' } }]);
    const native = new xdr.ChangeTrustOp({
      line: xdr.ChangeTrustAsset.assetTypeNative(),
      limit: xdr.Int64.fromString('1'),
    });
    expect(
      details(
        single(
          new xdr.Operation({ sourceAccount: null, body: xdr.OperationBody.changeTrust(native) }),
        ),
      ),
    ).toMatchObject([{ kind: 'change_trust', asset: { kind: 'native' } }]);
  });

  it('reads manage data, with and without a value', () => {
    const text = testSep10ChallengeXdr({
      server: TEST_INNER_SOURCE,
      client: TEST_DESTINATION,
      webAuthDomain: 'auth.example',
    });
    expect(details(text)).toEqual([
      {
        kind: 'manage_data',
        name: 'anchor.example auth',
        value: Uint8Array.from(Buffer.from('A'.repeat(64))),
      },
      {
        kind: 'manage_data',
        name: 'web_auth_domain',
        value: Uint8Array.from(Buffer.from('auth.example')),
      },
    ]);
    expect(details(single(Operation.manageData({ name: 'gone', value: null })))).toEqual([
      { kind: 'manage_data', name: 'gone', value: null },
    ]);
  });

  it('reports other host functions and operations by kind only', () => {
    expect(
      details(single(Operation.uploadContractWasm({ wasm: Buffer.from('00', 'hex') }))),
    ).toEqual([{ kind: 'host_function' }]);
    expect(details(single(Operation.bumpSequence({ bumpTo: '9' })))).toEqual([{ kind: 'other' }]);
  });
});
