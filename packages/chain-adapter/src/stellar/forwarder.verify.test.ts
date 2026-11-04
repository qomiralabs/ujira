// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// After creation the account is read back from the chain. The principal's
// key must be its only signer, at default thresholds, and UJIRA only the
// reserve sponsor. Any other shape is refused and flagged: a UJIRA signer
// would be custody, and a stranger's signer could empty the account.

import { Asset, Keypair, xdr } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';

import { ChainUnavailableError, InvalidInputError, RpcTimeoutError } from '../errors.js';
import type { TenantScope } from '../types.js';

import { confirmForwarder, forwarderFaults, readForwarderAccount } from './forwarder.js';
import type { ForwarderPorts, ForwarderRecord } from './forwarder.js';

const NETWORK = 'stellar:testnet' as const;
const SCOPE = {
  principalId: '0199a1f6-1e3f-7c21-9b8a-2d4e6f8a0b12',
  projectId: '0199a1f6-4c7d-7a55-8e21-5b9c7d3e1f04',
} as TenantScope;
const pair = (fill: number): Keypair => Keypair.fromRawEd25519Seed(Buffer.alloc(32, fill));
const SPONSOR = pair(1);
const FORWARDER = pair(2);
const ISSUER = pair(3);
const STRANGER = pair(4);
const USDC = { code: 'USDC', issuer: ISSUER.publicKey() };
const EXPECTED = { sponsor: SPONSOR.publicKey(), forwarder: FORWARDER.publicKey(), asset: USDC };

const accountId = (k: Keypair): xdr.PublicKey =>
  xdr.PublicKey.publicKeyTypeEd25519(k.rawPublicKey());

interface AccountShape {
  readonly id?: Keypair;
  readonly thresholds?: readonly number[];
  readonly signers?: readonly { readonly key: Keypair; readonly weight: number }[];
  readonly sponsor?: Keypair | null;
}

function accountEntry(shape: AccountShape = {}): string {
  const signers = (shape.signers ?? []).map(
    ({ key, weight }) =>
      new xdr.Signer({ key: xdr.SignerKey.signerKeyTypeEd25519(key.rawPublicKey()), weight }),
  );
  const account = new xdr.AccountEntry({
    accountId: accountId(shape.id ?? FORWARDER),
    balance: xdr.Int64.fromString('0'),
    seqNum: xdr.Int64.fromString('1'),
    numSubEntries: 1 + signers.length,
    inflationDest: null,
    flags: 0,
    homeDomain: '',
    thresholds: Buffer.from(shape.thresholds ?? [1, 0, 0, 0]),
    signers,
    ext: new xdr.AccountEntryExt(0),
  });
  return ledgerEntry(xdr.LedgerEntryData.account(account), shape.sponsor);
}

function trustlineEntry(
  shape: { readonly asset?: typeof USDC; readonly sponsor?: Keypair | null } = {},
): string {
  const asset = shape.asset ?? USDC;
  const line = new xdr.TrustLineEntry({
    accountId: accountId(FORWARDER),
    asset: new Asset(asset.code, asset.issuer).toTrustLineXDRObject(),
    balance: xdr.Int64.fromString('0'),
    limit: xdr.Int64.fromString('9223372036854775807'),
    flags: 1,
    ext: new xdr.TrustLineEntryExt(0),
  });
  return ledgerEntry(xdr.LedgerEntryData.trustline(line), shape.sponsor);
}

function ledgerEntry(data: xdr.LedgerEntryData, sponsor: Keypair | null | undefined): string {
  const by = sponsor === undefined ? SPONSOR : sponsor;
  const ext =
    by === null
      ? new xdr.LedgerEntryExt(0)
      : new xdr.LedgerEntryExt(
          1,
          new xdr.LedgerEntryExtensionV1({
            sponsoringId: accountId(by),
            ext: new xdr.LedgerEntryExtensionV1Ext(0),
          }),
        );
  return new xdr.LedgerEntry({ lastModifiedLedgerSeq: 7, data, ext }).toXDR('base64');
}

function faultsOf(account: string, trustline: string | null): readonly string[] {
  return forwarderFaults(readForwarderAccount(account, trustline), EXPECTED);
}

function world(account: string, trustline: string | null) {
  const records: ForwarderRecord[] = [];
  const flags: unknown[] = [];
  const ports: ForwarderPorts = {
    reader: { readEntries: () => Promise.resolve({ account, trustline }) },
    store: {
      record: (row) => {
        records.push(row);
        return Promise.resolve();
      },
    },
    flags: {
      flag: (event) => {
        flags.push(event);
      },
    },
  };
  return { ports, records, flags };
}

const REQUEST = {
  scope: SCOPE,
  network: NETWORK,
  sponsorTxHash: 'ab'.repeat(32),
  timeoutMs: 1_000,
  ...EXPECTED,
};

describe('forwarder.verify.test.ts', () => {
  it('accepts the one good shape', () => {
    expect(faultsOf(accountEntry(), trustlineEntry())).toEqual([]);
  });

  it('rejects an account with any extra signer', () => {
    // The sponsor as a signer is custody; anyone else could empty the account.
    for (const key of [SPONSOR, STRANGER]) {
      expect(faultsOf(accountEntry({ signers: [{ key, weight: 1 }] }), trustlineEntry())).toEqual([
        'extra_signer',
      ]);
    }
  });

  it('rejects anything but default thresholds and a master key of weight 1', () => {
    expect(faultsOf(accountEntry({ thresholds: [0, 0, 0, 0] }), trustlineEntry())).toEqual([
      'master_weight',
    ]);
    expect(faultsOf(accountEntry({ thresholds: [2, 0, 0, 0] }), trustlineEntry())).toEqual([
      'master_weight',
    ]);
    for (const thresholds of [
      [1, 1, 0, 0],
      [1, 0, 1, 0],
      [1, 0, 0, 1],
    ]) {
      expect(faultsOf(accountEntry({ thresholds }), trustlineEntry())).toEqual(['thresholds']);
    }
  });

  it('rejects a different reserve sponsor, on the account or the trustline', () => {
    expect(faultsOf(accountEntry({ sponsor: STRANGER }), trustlineEntry())).toEqual([
      'account_sponsor',
    ]);
    expect(faultsOf(accountEntry({ sponsor: null }), trustlineEntry())).toEqual([
      'account_sponsor',
    ]);
    expect(faultsOf(accountEntry(), trustlineEntry({ sponsor: STRANGER }))).toEqual([
      'trustline_sponsor',
    ]);
  });

  it('rejects a wrong account, a missing trustline and a wrong asset', () => {
    expect(faultsOf(accountEntry({ id: STRANGER }), trustlineEntry())).toEqual(['wrong_account']);
    expect(faultsOf(accountEntry(), null)).toEqual(['trustline_missing']);
    expect(
      faultsOf(
        accountEntry(),
        trustlineEntry({ asset: { code: 'EURC', issuer: ISSUER.publicKey() } }),
      ),
    ).toEqual(['trustline_asset']);
  });

  it('reads a long asset code, and treats a line that is no credit asset as the wrong asset', () => {
    const long = { code: 'USDCLONGCODE', issuer: ISSUER.publicKey() };
    expect(
      readForwarderAccount(accountEntry(), trustlineEntry({ asset: long })).trustline?.asset,
    ).toEqual(long);
    const pool = new xdr.TrustLineEntry({
      accountId: accountId(FORWARDER),
      asset: xdr.TrustLineAsset.assetTypePoolShare(Buffer.alloc(32, 9) as unknown as xdr.Hash),
      balance: xdr.Int64.fromString('0'),
      limit: xdr.Int64.fromString('1'),
      flags: 1,
      ext: new xdr.TrustLineEntryExt(0),
    });
    expect(
      faultsOf(accountEntry(), ledgerEntry(xdr.LedgerEntryData.trustline(pool), SPONSOR)),
    ).toEqual(['trustline_asset']);
  });

  it('rejects a trustline that belongs to another account', () => {
    const line = new xdr.TrustLineEntry({
      accountId: accountId(STRANGER),
      asset: new Asset(USDC.code, USDC.issuer).toTrustLineXDRObject(),
      balance: xdr.Int64.fromString('0'),
      limit: xdr.Int64.fromString('1'),
      flags: 1,
      ext: new xdr.TrustLineEntryExt(0),
    });
    expect(
      faultsOf(accountEntry(), ledgerEntry(xdr.LedgerEntryData.trustline(line), SPONSOR)),
    ).toEqual(['trustline_asset']);
  });

  it('reports every fault it finds', () => {
    expect(
      faultsOf(
        accountEntry({
          signers: [{ key: SPONSOR, weight: 1 }],
          sponsor: null,
          thresholds: [1, 1, 1, 1],
        }),
        null,
      ),
    ).toEqual(['thresholds', 'extra_signer', 'account_sponsor', 'trustline_missing']);
  });

  it('refuses text that is not the entry it should be', () => {
    for (const [account, trustline] of [
      ['not xdr', null],
      [trustlineEntry(), null],
      [accountEntry(), accountEntry()],
      [accountEntry(), 'not xdr'],
    ] as const) {
      expect(() => readForwarderAccount(account, trustline)).toThrow(InvalidInputError);
    }
  });

  it('records a verified account with principal and project on the row', async () => {
    const { ports, records, flags } = world(accountEntry(), trustlineEntry());
    const row = await confirmForwarder(REQUEST, ports);
    expect(row).toEqual({
      principalId: SCOPE.principalId,
      projectId: SCOPE.projectId,
      network: NETWORK,
      address: FORWARDER.publicKey(),
      sponsor: SPONSOR.publicKey(),
      sponsorTxHash: REQUEST.sponsorTxHash,
      status: 'active',
      faults: [],
    });
    expect(records).toEqual([row]);
    expect(flags).toEqual([]);
  });

  it('refuses, records and flags any other shape, and names no key in the flag', async () => {
    const { ports, records, flags } = world(
      accountEntry({ signers: [{ key: SPONSOR, weight: 1 }] }),
      trustlineEntry(),
    );
    const row = await confirmForwarder(REQUEST, ports);
    expect(row.status).toBe('rejected');
    expect(row.faults).toEqual(['extra_signer']);
    expect(records).toEqual([row]);
    expect(flags).toEqual([
      {
        principalId: SCOPE.principalId,
        projectId: SCOPE.projectId,
        network: NETWORK,
        faults: ['extra_signer'],
      },
    ]);
  });

  it('treats an account the chain does not have as not created, without a record', async () => {
    const { ports, records } = world(accountEntry(), trustlineEntry());
    const missing: ForwarderPorts = {
      ...ports,
      reader: { readEntries: () => Promise.resolve({ account: null, trustline: null }) },
    };
    await expect(confirmForwarder(REQUEST, missing)).rejects.toBeInstanceOf(InvalidInputError);
    expect(records).toEqual([]);
  });

  it('reads a failed read as the chain being unavailable, repeating none of its text', async () => {
    const { ports, records } = world(accountEntry(), trustlineEntry());
    const failing: ForwarderPorts = {
      ...ports,
      reader: { readEntries: () => Promise.reject(new TypeError('fetch failed: key=secret')) },
    };
    const err: unknown = await confirmForwarder(REQUEST, failing).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainUnavailableError);
    expect(String((err as ChainUnavailableError).cause)).not.toContain('secret');
    expect(records).toEqual([]);
    const typed = new RpcTimeoutError({ network: NETWORK, landed: 'no' });
    const passing: ForwarderPorts = {
      ...ports,
      reader: { readEntries: () => Promise.reject(typed) },
    };
    await expect(confirmForwarder(REQUEST, passing)).rejects.toBe(typed);
  });

  it('refuses a request it cannot trust, before reading anything', async () => {
    const { ports } = world(accountEntry(), trustlineEntry());
    for (const bad of [
      { ...REQUEST, sponsorTxHash: 'zz' },
      { ...REQUEST, timeoutMs: 0 },
      { ...REQUEST, forwarder: 'CABC' },
      { ...REQUEST, scope: { principalId: 'x', projectId: 'y' } },
      { ...REQUEST, secret: 'S' },
    ]) {
      await expect(confirmForwarder(bad as never, ports)).rejects.toBeInstanceOf(InvalidInputError);
    }
  });

  it('times out a read that never answers, with nothing recorded', async () => {
    const { ports, records } = world(accountEntry(), trustlineEntry());
    const hung: ForwarderPorts = {
      ...ports,
      reader: { readEntries: () => new Promise(() => undefined) },
    };
    const err: unknown = await confirmForwarder({ ...REQUEST, timeoutMs: 20 }, hung).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RpcTimeoutError);
    expect((err as RpcTimeoutError).landed).toBe('no');
    expect(records).toEqual([]);
  });
});
