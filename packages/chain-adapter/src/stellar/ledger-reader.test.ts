// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for createStellarLedgerReader (ledger-reader.ts), against a fake
 * RPC holding real XDR.
 *
 * Every key goes in one getLedgerEntries call. Entries are matched by key,
 * so order does not matter and a missing entry is null. Accounts decode to
 * the master weight, thresholds and signers of every kind; trustlines to
 * the balance, limit, flags and buying liabilities, which are zero when the
 * entry has no extension. Undecodable data is InvalidInputError. On top of
 * it, checkStellarDestination makes one RPC call per check.
 */

import { Asset, Keypair, xdr } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';

import { encodeAccountAddress } from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';
import { checkStellarDestination } from './check-destination.js';
import { createStellarLedgerReader } from './ledger-reader.js';
import type { RpcLedgerEntry } from './rpc.js';

const G = (fill: number) => encodeAccountAddress(new Uint8Array(32).fill(fill));
const ACCOUNT = G(1);
const SIGNER = G(2);
const ASSET = { code: 'USDC', issuer: G(3) };
const NETWORK = 'stellar:testnet';
const OPTS = { correlationId: 'corr-1' };

const accountId = (address: string) => Keypair.fromPublicKey(address).xdrAccountId();
const rawKey = (address: string) => Keypair.fromPublicKey(address).rawPublicKey();

const accountKey = xdr.LedgerKey.account(
  new xdr.LedgerKeyAccount({ accountId: accountId(ACCOUNT) }),
).toXDR('base64');
const trustlineKey = xdr.LedgerKey.trustline(
  new xdr.LedgerKeyTrustLine({
    accountId: accountId(ACCOUNT),
    asset: new Asset(ASSET.code, ASSET.issuer).toTrustLineXDRObject(),
  }),
).toXDR('base64');

function accountXdr(): string {
  const signers = [
    new xdr.Signer({ key: xdr.SignerKey.signerKeyTypeEd25519(rawKey(SIGNER)), weight: 5 }),
    new xdr.Signer({ key: xdr.SignerKey.signerKeyTypeHashX(Buffer.alloc(32, 9)), weight: 7 }),
    new xdr.Signer({ key: xdr.SignerKey.signerKeyTypePreAuthTx(Buffer.alloc(32, 8)), weight: 6 }),
  ];
  return xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: accountId(ACCOUNT),
      balance: xdr.Int64.fromString('10000000'),
      seqNum: xdr.Int64.fromString('1'),
      numSubEntries: 1,
      inflationDest: null,
      flags: 0,
      homeDomain: '',
      thresholds: Buffer.from([1, 2, 3, 4]),
      signers,
      // A union with no arm is four zero bytes on the wire.
      ext: xdr.AccountEntryExt.fromXDR(Buffer.alloc(4)),
    }),
  ).toXDR('base64');
}

function int32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeInt32BE(value);
  return out;
}

function int64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64BE(value);
  return out;
}

function trustlineXdr(buying: bigint | null): string {
  // Version 1 of the extension holds buying then selling liabilities, then
  // its own empty extension.
  const ext =
    buying === null
      ? Buffer.alloc(4)
      : Buffer.concat([int32(1), int64(buying), int64(0n), int32(0)]);
  return xdr.LedgerEntryData.trustline(
    new xdr.TrustLineEntry({
      accountId: accountId(ACCOUNT),
      asset: new Asset(ASSET.code, ASSET.issuer).toTrustLineXDRObject(),
      balance: xdr.Int64.fromString('600'),
      limit: xdr.Int64.fromString('1000'),
      flags: 1,
      ext: xdr.TrustLineEntryExt.fromXDR(ext),
    }),
  ).toXDR('base64');
}

function entry(key: string, data: string): RpcLedgerEntry {
  return { key, xdr: data, lastModifiedLedgerSeq: 5 };
}

function fakeRpc(entries: readonly RpcLedgerEntry[]) {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    rpc: {
      getLedgerEntries: (keys: readonly string[]) => {
        calls.push(keys);
        return Promise.resolve({ latestLedger: 9, entries });
      },
    },
  };
}

const KEYS = [
  { kind: 'account', accountId: ACCOUNT },
  { kind: 'trustline', accountId: ACCOUNT, asset: ASSET },
] as const;

describe('createStellarLedgerReader', () => {
  it('asks for every key in one call and matches entries by key', async () => {
    // The RPC may answer in any order.
    const { rpc, calls } = fakeRpc([
      entry(trustlineKey, trustlineXdr(100n)),
      entry(accountKey, accountXdr()),
    ]);
    const answer = await createStellarLedgerReader(rpc).getLedgerEntries(NETWORK, KEYS, OPTS);
    expect(calls).toEqual([[accountKey, trustlineKey]]);
    expect(answer).toEqual([
      {
        kind: 'account',
        accountId: ACCOUNT,
        masterWeight: 1,
        thresholds: { low: 2, medium: 3, high: 4 },
        signers: [
          { kind: 'ed25519', key: SIGNER, weight: 5 },
          { kind: 'hash_x', key: expect.any(String) as string, weight: 7 },
          { kind: 'pre_auth_tx', key: expect.any(String) as string, weight: 6 },
        ],
      },
      {
        kind: 'trustline',
        accountId: ACCOUNT,
        asset: ASSET,
        balance: 600n,
        limit: 1000n,
        buyingLiabilities: 100n,
        flags: 1,
      },
    ]);
  });

  it('reads a missing entry as null and no extension as zero liabilities', async () => {
    const { rpc } = fakeRpc([entry(trustlineKey, trustlineXdr(null))]);
    const [account, trustline] = await createStellarLedgerReader(rpc).getLedgerEntries(
      NETWORK,
      KEYS,
      OPTS,
    );
    expect(account).toBeNull();
    expect(trustline).toMatchObject({ buyingLiabilities: 0n });
  });

  it('refuses data it cannot decode, without quoting it', async () => {
    const { rpc } = fakeRpc([entry(accountKey, 'AAAA')]);
    const error: unknown = await createStellarLedgerReader(rpc)
      .getLedgerEntries(NETWORK, KEYS, OPTS)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as InvalidInputError).issues).toEqual(['ledgerEntries (invalid)']);
  });

  it('gives a destination check one RPC call', async () => {
    const { rpc, calls } = fakeRpc([
      entry(accountKey, accountXdr()),
      entry(trustlineKey, trustlineXdr(100n)),
    ]);
    const reader = createStellarLedgerReader(rpc);
    const check = (amount: bigint) =>
      checkStellarDestination(
        NETWORK,
        { destination: ACCOUNT, asset: ASSET, amount, proofSigner: SIGNER },
        reader,
        OPTS,
      );
    expect(await check(300n)).toEqual({ receivable: true, proofSigner: 'current' });
    expect(calls).toHaveLength(1);
    expect(await check(301n)).toEqual({
      receivable: false,
      reason: 'TRUSTLINE_LIMIT',
      proofSigner: 'current',
    });
  });
});
