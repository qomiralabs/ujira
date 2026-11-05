// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Whether a destination can take a payout right now, read fresh from the chain.
// A trustline existing is not enough: an issuer can leave it maintain-only, and
// a full limit refuses the transfer too. Either would fail only at execution,
// after a request was stored and funds were committed to it, so both are caught
// here. A contract has no trustline, and what it accepts cannot be read without
// calling it, so a C destination counts as able to receive.

import { Asset, Keypair, StrKey, xdr } from '@stellar/stellar-sdk/base';

import type { CallOptions, Destination } from '../types.js';
import { accountKey } from './tx.js';
import type { StellarRpc } from './rpc.js';

const AUTHORIZED_FLAG = 1;

export type NotReceivable =
  | 'ACCOUNT_NOT_FOUND'
  | 'NO_TRUSTLINE'
  | 'TRUSTLINE_NOT_AUTHORIZED'
  | 'TRUSTLINE_LIMIT'
  | 'DESTINATION_IS_ISSUER';

export type ProofSigner = 'current' | 'not_current' | 'not_applicable';

export type DestinationState =
  | { readonly receivable: true; readonly proofSigner: ProofSigner }
  | {
      readonly receivable: false;
      readonly reason: NotReceivable;
      readonly proofSigner: ProofSigner;
    };

export function trustlineKey(account: string, issuer: string): string {
  return xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: Keypair.fromPublicKey(account).xdrPublicKey(),
      asset: xdr.TrustLineAsset.fromXdr(
        new Asset('USDC', issuer).toTrustLineXdrObject().toXdr('base64'),
        'base64',
      ),
    }),
  ).toXdr('base64');
}

function signerState(account: xdr.AccountEntry, owner: string, proof: string | undefined) {
  if (proof === undefined) return 'not_applicable' as const;
  const masterWeight = account.thresholds.value[0] ?? 0;
  if (proof === owner) return masterWeight > 0 ? ('current' as const) : ('not_current' as const);
  const listed = account.signers.some((s) => {
    const key = s.key;
    return (
      key.type === 'signerKeyTypeEd25519' &&
      s.weight > 0 &&
      StrKey.encodeEd25519PublicKey(Buffer.from(key.ed25519.value)) === proof
    );
  });
  return listed ? ('current' as const) : ('not_current' as const);
}

/** The destination's state for `amount` of USDC, with `amount` left out to check it alone. */
export async function readDestination(
  rpc: Pick<StellarRpc, 'getLedgerEntries'>,
  usdcIssuer: string,
  request: {
    readonly destination: Destination;
    readonly amount?: bigint;
    readonly proofSigner?: string;
  },
  opts: CallOptions,
): Promise<DestinationState> {
  const address = request.destination.address.value;
  if (address.startsWith('C')) return { receivable: true, proofSigner: 'not_applicable' };
  if (address === usdcIssuer) {
    return { receivable: false, reason: 'DESTINATION_IS_ISSUER', proofSigner: 'not_applicable' };
  }
  const accountAt = accountKey(address);
  const trustAt = trustlineKey(address, usdcIssuer);
  const { entries } = await rpc.getLedgerEntries([accountAt, trustAt], opts);
  const read = (key: string) => {
    const entry = entries.find((e) => e.key === key);
    return entry === undefined ? null : xdr.LedgerEntryData.fromXdr(entry.xdr, 'base64');
  };
  const account = read(accountAt);
  if (account?.type !== 'account') {
    return { receivable: false, reason: 'ACCOUNT_NOT_FOUND', proofSigner: 'not_applicable' };
  }
  const proofSigner = signerState(account.account, address, request.proofSigner);
  const line = read(trustAt);
  if (line?.type !== 'trustline') {
    return { receivable: false, reason: 'NO_TRUSTLINE', proofSigner };
  }
  if ((line.trustLine.flags & AUTHORIZED_FLAG) === 0) {
    return { receivable: false, reason: 'TRUSTLINE_NOT_AUTHORIZED', proofSigner };
  }
  if (request.amount !== undefined) {
    const headroom = line.trustLine.limit - line.trustLine.balance;
    if (headroom < request.amount) {
      return { receivable: false, reason: 'TRUSTLINE_LIMIT', proofSigner };
    }
  }
  return { receivable: true, proofSigner };
}
