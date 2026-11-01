// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the authorization entry codecs (codecs/auth-entry.ts,
 * exported from the @ujira/chain-adapter/codecs subpath).
 *
 * decodeAuthEntry(entryXdr, network, expirationLedger) reads a base64
 * Soroban authorization entry into its credentials, the invocation tree it
 * authorizes and, for address credentials, the 32 byte hash the address
 * signs to authorize it on that network until that ledger. Source account
 * credentials have no hash: the transaction signature covers them.
 * attachAuthEntrySignature(entryXdr, signature, expirationLedger) writes the
 * expiration and an account signature in the form the host checks, and only
 * for an entry whose credentials name the G account of that key.
 *
 * Malformed input, an address kind no UJIRA key can be, an expiration
 * outside u32 or an unknown network throws InvalidInputError naming the
 * argument, never the value.
 */

import { Address, Keypair, Networks, authorizeEntry, xdr } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.js';
import { ed25519PublicKey, ed25519Sign, ed25519Verify } from '../testing/bytes.js';
import { TEST_CONTRACT, testAuthEntryXdr } from '../testing/stellar.js';
import * as codecs from './index.js';

const { attachAuthEntrySignature, decodeAuthEntry, encodeAccountAddress, encodeMuxedAddress } =
  codecs;

const SEED = new Uint8Array(32).fill(7);
const PUBLIC_KEY = ed25519PublicKey(SEED);
const ADDRESS = encodeAccountAddress(PUBLIC_KEY);
const KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.from(SEED));
const OTHER_SEED = new Uint8Array(32).fill(9);
const LEDGER = 1_000_000;

function issuesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidInputError);
    return (error as InvalidInputError).issues;
  }
  throw new Error('expected a throw');
}

function sign(seed: Uint8Array, hash: Uint8Array) {
  return { publicKey: ed25519PublicKey(seed), signature: ed25519Sign(seed, hash) };
}

function entryOf(text: string): xdr.SorobanAuthorizationEntry {
  return xdr.SorobanAuthorizationEntry.fromXDR(text, 'base64');
}

function withCredentialAddress(address: xdr.ScAddress): string {
  const entry = entryOf(testAuthEntryXdr({ address: ADDRESS }));
  entry.credentials().address().address(address);
  return entry.toXDR('base64');
}

function withFunction(fn: xdr.SorobanAuthorizedFunction, sub: xdr.SorobanAuthorizedInvocation[]) {
  const entry = entryOf(testAuthEntryXdr({ address: ADDRESS }));
  entry.rootInvocation(new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: sub }));
  return entry.toXDR('base64');
}

describe('authorization entries', () => {
  it('round trips a testnet entry: build, decode, sign, attach and re-parse', async () => {
    const unsigned = testAuthEntryXdr({ address: ADDRESS, nonce: 99n, functionName: 'approve' });
    const decoded = decodeAuthEntry(unsigned, 'stellar:testnet', LEDGER);

    expect(decoded.network).toBe('stellar:testnet');
    expect(decoded.expirationLedger).toBe(LEDGER);
    expect(decoded.credentials).toEqual({
      kind: 'address',
      address: ADDRESS,
      nonce: 99n,
      signatureExpirationLedger: 0,
      signed: false,
    });
    expect(decoded.invocation).toEqual({
      kind: 'contract_fn',
      contract: TEST_CONTRACT,
      functionName: 'approve',
      argCount: 1,
      subInvocations: [],
    });
    expect(decoded.hash).toHaveLength(32);

    const signed = attachAuthEntrySignature(
      unsigned,
      sign(SEED, decoded.hash ?? new Uint8Array()),
      LEDGER,
    );
    const reparsed = decodeAuthEntry(signed, 'stellar:testnet', LEDGER);
    expect(reparsed.credentials).toMatchObject({ signed: true, signatureExpirationLedger: LEDGER });
    // Signing does not change what is signed.
    expect(reparsed.hash).toEqual(decoded.hash);

    // The library's own signing gives the same entry, byte for byte, so the
    // hash and the signature layout are the ones the host verifies.
    const reference = await authorizeEntry(entryOf(unsigned), KEYPAIR, LEDGER, Networks.TESTNET);
    expect(signed).toBe(reference.toXDR('base64'));

    // The signature in the entry verifies against the key.
    const [map] = entryOf(signed).credentials().address().signature().vec() ?? [];
    const fields = new Map(
      (map?.map() ?? []).map((e) => [e.key().sym().toString(), Uint8Array.from(e.val().bytes())]),
    );
    expect(fields.get('public_key')).toEqual(PUBLIC_KEY);
    expect(
      ed25519Verify(
        PUBLIC_KEY,
        decoded.hash ?? new Uint8Array(),
        fields.get('signature') ?? new Uint8Array(),
      ),
    ).toBe(true);
  });

  it('binds the hash to the network and the expiration ledger', () => {
    const unsigned = testAuthEntryXdr({ address: ADDRESS });
    const a = decodeAuthEntry(unsigned, 'stellar:testnet', LEDGER).hash;
    expect(decodeAuthEntry(unsigned, 'stellar:pubnet', LEDGER).hash).not.toEqual(a);
    expect(decodeAuthEntry(unsigned, 'stellar:testnet', LEDGER + 1).hash).not.toEqual(a);
  });

  it('has no hash under source account credentials, and refuses to sign one', () => {
    const entry = entryOf(testAuthEntryXdr({ address: ADDRESS }));
    entry.credentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount());
    const text = entry.toXDR('base64');
    const decoded = decodeAuthEntry(text, 'stellar:testnet', LEDGER);
    expect(decoded.credentials).toEqual({ kind: 'source_account' });
    expect(decoded.hash).toBeNull();
    expect(
      issuesOf(() => attachAuthEntrySignature(text, sign(SEED, new Uint8Array(32)), LEDGER)),
    ).toEqual(['entryXdr (source_account_credentials)']);
  });

  it('reads contract and muxed credentials, and signs neither', () => {
    const contract = withCredentialAddress(Address.fromString(TEST_CONTRACT).toScAddress());
    expect(decodeAuthEntry(contract, 'stellar:testnet', LEDGER).credentials).toMatchObject({
      address: TEST_CONTRACT,
    });
    const muxed = withCredentialAddress(
      xdr.ScAddress.scAddressTypeMuxedAccount(
        new xdr.MuxedEd25519Account({
          id: xdr.Uint64.fromString('5'),
          ed25519: Buffer.from(PUBLIC_KEY),
        }),
      ),
    );
    expect(decodeAuthEntry(muxed, 'stellar:testnet', LEDGER).credentials).toMatchObject({
      address: encodeMuxedAddress(PUBLIC_KEY, 5n),
    });
    for (const text of [contract, muxed]) {
      expect(
        issuesOf(() => attachAuthEntrySignature(text, sign(SEED, new Uint8Array(32)), LEDGER)),
      ).toEqual(['entryXdr (unsupported_credentials)']);
    }
  });

  it('refuses an address kind no key can hold', () => {
    const text = withCredentialAddress(
      xdr.ScAddress.scAddressTypeClaimableBalance(
        xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(Buffer.alloc(32)),
      ),
    );
    expect(issuesOf(() => decodeAuthEntry(text, 'stellar:testnet', LEDGER))).toEqual([
      'entryXdr (unsupported_address)',
    ]);
  });

  it('refuses a key that is not the one the credentials name', () => {
    const unsigned = testAuthEntryXdr({ address: ADDRESS });
    const { hash } = decodeAuthEntry(unsigned, 'stellar:testnet', LEDGER);
    expect(
      issuesOf(() =>
        attachAuthEntrySignature(unsigned, sign(OTHER_SEED, hash ?? new Uint8Array()), LEDGER),
      ),
    ).toEqual(['publicKey (mismatch)']);
  });

  it('reads contract creation and nested invocations', () => {
    const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: Address.fromString(ADDRESS).toScAddress(),
        salt: Buffer.alloc(32),
      }),
    );
    const executable = xdr.ContractExecutable.contractExecutableStellarAsset();
    const create = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
      new xdr.CreateContractArgs({ contractIdPreimage: preimage, executable }),
    );
    const createV2 =
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(
        new xdr.CreateContractArgsV2({
          contractIdPreimage: preimage,
          executable,
          constructorArgs: [],
        }),
      );
    const leaf = entryOf(
      testAuthEntryXdr({ address: ADDRESS, functionName: 'transfer' }),
    ).rootInvocation();
    const text = withFunction(create, [
      new xdr.SorobanAuthorizedInvocation({ function: createV2, subInvocations: [leaf] }),
    ]);
    expect(decodeAuthEntry(text, 'stellar:testnet', LEDGER).invocation).toEqual({
      kind: 'create_contract',
      subInvocations: [
        {
          kind: 'create_contract',
          subInvocations: [
            {
              kind: 'contract_fn',
              contract: TEST_CONTRACT,
              functionName: 'transfer',
              argCount: 1,
              subInvocations: [],
            },
          ],
        },
      ],
    });
  });

  it.each([0, -1, 1.5, 2 ** 32, Number.NaN, '7'])('refuses the expiration ledger %s', (ledger) => {
    const unsigned = testAuthEntryXdr({ address: ADDRESS });
    expect(issuesOf(() => decodeAuthEntry(unsigned, 'stellar:testnet', ledger as number))).toEqual([
      'expirationLedger (out_of_range)',
    ]);
    expect(
      issuesOf(() =>
        attachAuthEntrySignature(unsigned, sign(SEED, new Uint8Array(32)), ledger as number),
      ),
    ).toEqual(['expirationLedger (out_of_range)']);
  });

  it('refuses a malformed entry, a bad signature and an unknown network', () => {
    const unsigned = testAuthEntryXdr({ address: ADDRESS });
    expect(issuesOf(() => decodeAuthEntry('AAAA', 'stellar:testnet', LEDGER))).toEqual([
      'entryXdr (malformed)',
    ]);
    expect(issuesOf(() => decodeAuthEntry(unsigned, 'stellar:local' as never, LEDGER))).toEqual([
      'network (invalid)',
    ]);
    expect(
      issuesOf(() =>
        attachAuthEntrySignature(
          unsigned,
          { publicKey: PUBLIC_KEY, signature: new Uint8Array(10) },
          LEDGER,
        ),
      ),
    ).toEqual(['signature (invalid_length)']);
  });
});
