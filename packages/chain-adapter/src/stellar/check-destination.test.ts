// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for checkStellarDestination (check-destination.ts).
 *
 * One getLedgerEntries call reads the account of the G (an M is read as
 * its G) and its trustline for the payout asset, in that order. The answer
 * is checked with zod and must be for that account. A C is receivable
 * without a read. The proof signer is current, not_current or
 * not_applicable when none was given; an absent account makes it
 * not_current and the destination ACCOUNT_NOT_FOUND.
 */

import { describe, expect, it } from 'vitest';

import {
  STRKEY_VERSION,
  decodeAccountAddress,
  encodeAccountAddress,
  encodeMuxedAddress,
  encodeStrkey,
} from '../codecs/strkey.js';
import { InvalidInputError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import { TRUSTLINE_AUTHORIZED } from './account-rules.js';
import { checkStellarDestination } from './check-destination.js';
import type {
  StellarLedgerEntry,
  StellarLedgerKey,
  StellarLedgerReader,
} from './check-destination.js';

const NETWORK: StellarNetworkId = 'stellar:testnet';
const G = (fill: number) => encodeAccountAddress(new Uint8Array(32).fill(fill));
const ACCOUNT = G(1);
const SIGNER = G(2);
const ASSET = { code: 'USDC', issuer: G(3) };
const opts = { correlationId: 'corr-1' };

const accountEntry: StellarLedgerEntry = {
  kind: 'account',
  accountId: ACCOUNT,
  masterWeight: 1,
  thresholds: { low: 1, medium: 1, high: 1 },
  signers: [{ kind: 'ed25519', key: SIGNER, weight: 1 }],
};
const trustlineEntry: StellarLedgerEntry = {
  kind: 'trustline',
  accountId: ACCOUNT,
  asset: ASSET,
  balance: 0n,
  limit: 100n,
  buyingLiabilities: 0n,
  flags: TRUSTLINE_AUTHORIZED,
};

/** A fake RPC that records every call. */
function fakeLedger(answer: readonly unknown[]): {
  reader: StellarLedgerReader;
  calls: (readonly StellarLedgerKey[])[];
} {
  const calls: (readonly StellarLedgerKey[])[] = [];
  return {
    calls,
    reader: {
      getLedgerEntries: (_network, keys) => {
        calls.push(keys);
        return Promise.resolve(answer as readonly (StellarLedgerEntry | null)[]);
      },
    },
  };
}

describe('checkStellarDestination', () => {
  it('one getLedgerEntries call per check', async () => {
    const { reader, calls } = fakeLedger([accountEntry, trustlineEntry]);
    const result = await checkStellarDestination(
      NETWORK,
      { destination: ACCOUNT, asset: ASSET, amount: 50n, proofSigner: SIGNER },
      reader,
      opts,
    );
    expect(result).toEqual({ receivable: true, proofSigner: 'current' });
    expect(calls).toEqual([
      [
        { kind: 'account', accountId: ACCOUNT },
        { kind: 'trustline', accountId: ACCOUNT, asset: ASSET },
      ],
    ]);
  });

  it('reads an M as the G behind it', async () => {
    const { reader, calls } = fakeLedger([accountEntry, trustlineEntry]);
    const muxed = encodeMuxedAddress(decodeAccountAddress(ACCOUNT), 9n);
    await checkStellarDestination(NETWORK, { destination: muxed, asset: ASSET }, reader, opts);
    expect(calls[0]?.[0]).toEqual({ kind: 'account', accountId: ACCOUNT });
  });

  it('receives at a contract without reading the ledger', async () => {
    const { reader, calls } = fakeLedger([]);
    const contract = encodeStrkey(STRKEY_VERSION.contract, new Uint8Array(32).fill(5));
    expect(
      await checkStellarDestination(NETWORK, { destination: contract, asset: ASSET }, reader, opts),
    ).toEqual({ receivable: true, proofSigner: 'not_applicable' });
    expect(calls).toHaveLength(0);
  });

  it('reports a missing account for receivability and the proof', async () => {
    const { reader } = fakeLedger([null, null]);
    expect(
      await checkStellarDestination(
        NETWORK,
        { destination: ACCOUNT, asset: ASSET, proofSigner: SIGNER },
        reader,
        opts,
      ),
    ).toEqual({ receivable: false, reason: 'ACCOUNT_NOT_FOUND', proofSigner: 'not_current' });
  });

  it('reports each refusal and the proof signer status', async () => {
    const { reader } = fakeLedger([accountEntry, null]);
    expect(
      await checkStellarDestination(
        NETWORK,
        { destination: ACCOUNT, asset: ASSET, proofSigner: G(9) },
        reader,
        opts,
      ),
    ).toEqual({ receivable: false, reason: 'NO_TRUSTLINE', proofSigner: 'not_current' });
    const full = fakeLedger([accountEntry, trustlineEntry]);
    expect(
      await checkStellarDestination(
        NETWORK,
        { destination: ACCOUNT, asset: ASSET, amount: 101n },
        full.reader,
        opts,
      ),
    ).toEqual({ receivable: false, reason: 'TRUSTLINE_LIMIT', proofSigner: 'not_applicable' });
  });

  it('refuses a malformed answer or one for another account', async () => {
    for (const answer of [
      [accountEntry],
      [{ ...accountEntry, masterWeight: 256 }, null],
      [{ ...accountEntry, extra: true }, null],
      [{ ...accountEntry, accountId: G(8) }, null],
      [accountEntry, { ...trustlineEntry, accountId: G(8) }],
      [accountEntry, { ...trustlineEntry, asset: { code: 'EURC', issuer: ASSET.issuer } }],
      [accountEntry, { ...trustlineEntry, asset: { code: 'USDC', issuer: G(8) } }],
    ]) {
      const { reader } = fakeLedger(answer);
      await expect(
        checkStellarDestination(NETWORK, { destination: ACCOUNT, asset: ASSET }, reader, opts),
      ).rejects.toBeInstanceOf(InvalidInputError);
    }
  });

  it('refuses a destination that is not an address', async () => {
    const { reader } = fakeLedger([]);
    await expect(
      checkStellarDestination(NETWORK, { destination: 'nope', asset: ASSET }, reader, opts),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});
