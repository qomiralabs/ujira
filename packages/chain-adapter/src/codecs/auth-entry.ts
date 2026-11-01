// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Soroban authorization entries: what an address authorizes, read into
// plain data, the hash it signs for that, and the signed entry. The hash
// covers the network, the nonce, the expiration ledger and the whole
// invocation tree, so a signature cannot be moved to another call, another
// network or a later ledger.

import { xdr } from '@stellar/stellar-base';

import type { NetworkId } from '../networks.js';

import { checkNetwork, networkIdOf, sha256 } from './network.js';
import { STRKEY_VERSION, encodeStrkey } from './strkey.js';
import { bytes, checkSignature, invalid, readXdr, scAddressText } from './xdr.js';
import type { Ed25519SignatureParts } from './xdr.js';

const FIELD = 'entryXdr';
const U32_MAX = 0xffffffff;

export type DecodedAuthCredentials =
  /** Authorized by the transaction's own source signature; nothing to sign here. */
  | { readonly kind: 'source_account' }
  | {
      readonly kind: 'address';
      /** A G, C or M address. */
      readonly address: string;
      readonly nonce: bigint;
      /** As the entry carries it now; 0 before it is signed. */
      readonly signatureExpirationLedger: number;
      readonly signed: boolean;
    };

export type DecodedInvocation =
  | {
      readonly kind: 'contract_fn';
      readonly contract: string;
      readonly functionName: string;
      readonly argCount: number;
      readonly subInvocations: readonly DecodedInvocation[];
    }
  | {
      readonly kind: 'create_contract';
      readonly subInvocations: readonly DecodedInvocation[];
    };

export interface DecodedAuthEntry {
  readonly network: NetworkId;
  readonly credentials: DecodedAuthCredentials;
  readonly invocation: DecodedInvocation;
  /** The ledger the hash is for: the last one the signature is valid in. */
  readonly expirationLedger: number;
  /** What the credentials' address signs, or null under source account credentials. */
  readonly hash: Uint8Array | null;
}

function checkLedger(ledger: unknown): number {
  if (typeof ledger !== 'number' || !Number.isInteger(ledger) || ledger < 1 || ledger > U32_MAX) {
    throw invalid('expirationLedger', 'out_of_range');
  }
  return ledger;
}

function readEntry(text: unknown): xdr.SorobanAuthorizationEntry {
  return readXdr(text, FIELD, (input) => xdr.SorobanAuthorizationEntry.fromXDR(input, 'base64'));
}

function invocationOf(invocation: xdr.SorobanAuthorizedInvocation): DecodedInvocation {
  const fn = invocation.function();
  const subInvocations = invocation.subInvocations().map(invocationOf);
  if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') {
    return { kind: 'create_contract', subInvocations };
  }
  const args = fn.contractFn();
  return {
    kind: 'contract_fn',
    contract: scAddressText(args.contractAddress(), FIELD),
    functionName: args.functionName().toString(),
    argCount: args.args().length,
    subInvocations,
  };
}

function entryHash(
  entry: xdr.SorobanAuthorizationEntry,
  credentials: xdr.SorobanAddressCredentials,
  network: NetworkId,
  ledger: number,
): Uint8Array {
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: Buffer.from(networkIdOf(network)),
      nonce: credentials.nonce(),
      signatureExpirationLedger: ledger,
      invocation: entry.rootInvocation(),
    }),
  );
  return sha256(preimage.toXDR());
}

/**
 * An authorization entry as plain data, with the hash its address signs to
 * authorize it on `network` until `expirationLedger`.
 */
export function decodeAuthEntry(
  text: string,
  network: NetworkId,
  expirationLedger: number,
): DecodedAuthEntry {
  const checked = checkNetwork(network);
  const ledger = checkLedger(expirationLedger);
  const entry = readEntry(text);
  const invocation = invocationOf(entry.rootInvocation());
  const creds = entry.credentials();
  if (creds.switch().name !== 'sorobanCredentialsAddress') {
    return {
      network: checked,
      credentials: { kind: 'source_account' },
      invocation,
      expirationLedger: ledger,
      hash: null,
    };
  }
  const address = creds.address();
  return {
    network: checked,
    credentials: {
      kind: 'address',
      address: scAddressText(address.address(), FIELD),
      nonce: BigInt(address.nonce().toString()),
      signatureExpirationLedger: address.signatureExpirationLedger(),
      signed: address.signature().switch().name !== 'scvVoid',
    },
    invocation,
    expirationLedger: ledger,
    hash: entryHash(entry, address, checked, ledger),
  };
}

/**
 * The entry signed by a Stellar account: the expiration ledger set and the
 * signature written as the host's account check reads it, a vector of one
 * map holding public_key and signature. Only an entry whose credentials
 * name the G account of `parts.publicKey` is signed, since a smart wallet
 * checks its own signature format and no UJIRA key is one.
 */
export function attachAuthEntrySignature(
  text: string,
  parts: Ed25519SignatureParts,
  expirationLedger: number,
): string {
  const { publicKey, signature } = checkSignature(parts);
  const ledger = checkLedger(expirationLedger);
  const entry = readEntry(text);
  const creds = entry.credentials();
  if (creds.switch().name !== 'sorobanCredentialsAddress') {
    throw invalid(FIELD, 'source_account_credentials');
  }
  const address = creds.address();
  const scAddress = address.address();
  if (scAddress.switch().name !== 'scAddressTypeAccount') {
    throw invalid(FIELD, 'unsupported_credentials');
  }
  const named = encodeStrkey(STRKEY_VERSION.account, bytes(scAddress.accountId().ed25519()));
  if (named !== encodeStrkey(STRKEY_VERSION.account, bytes(publicKey))) {
    throw invalid('publicKey', 'mismatch');
  }
  address.signatureExpirationLedger(ledger);
  address.signature(
    xdr.ScVal.scvVec([
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('public_key'),
          val: xdr.ScVal.scvBytes(publicKey),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('signature'),
          val: xdr.ScVal.scvBytes(signature),
        }),
      ]),
    ]),
  );
  return entry.toXDR('base64');
}
