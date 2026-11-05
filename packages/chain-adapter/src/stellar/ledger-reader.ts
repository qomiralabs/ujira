// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The ledger read behind wallet proofs and destination checks: every key in
// one getLedgerEntries call, decoded into the plain entries the rules read,
// so nothing above this file sees the XDR library's types.

import { Asset, Keypair, StrKey, xdr } from '@stellar/stellar-base';

import { InvalidInputError } from '../errors.js';
import type { CallOptions } from '../types.js';
import type {
  StellarAccountEntry,
  StellarAsset,
  StellarSignerEntry,
  StellarSignerKind,
  StellarTrustlineEntry,
} from './account-rules.js';
import type {
  StellarLedgerEntry,
  StellarLedgerKey,
  StellarLedgerReader,
} from './check-destination.js';
import type { StellarRpc } from './rpc.js';

const SIGNER_KINDS: Readonly<Record<string, StellarSignerKind>> = Object.freeze({
  signerKeyTypeEd25519: 'ed25519',
  signerKeyTypePreAuthTx: 'pre_auth_tx',
  signerKeyTypeHashX: 'hash_x',
  signerKeyTypeEd25519SignedPayload: 'signed_payload',
});

function keyOf(key: StellarLedgerKey): string {
  const accountId = Keypair.fromPublicKey(key.accountId).xdrAccountId();
  const ledgerKey =
    key.kind === 'account'
      ? xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }))
      : xdr.LedgerKey.trustline(
          new xdr.LedgerKeyTrustLine({
            accountId,
            asset: new Asset(key.asset.code, key.asset.issuer).toTrustLineXDRObject(),
          }),
        );
  return ledgerKey.toXDR('base64');
}

function accountIdText(accountId: xdr.AccountId): string {
  return StrKey.encodeEd25519PublicKey(accountId.ed25519());
}

function signerOf(signer: xdr.Signer): StellarSignerEntry {
  const key = signer.key();
  const name = key.switch().name;
  const kind = SIGNER_KINDS[name];
  if (kind === undefined) throw new InvalidInputError({ issues: ['ledgerEntries (invalid)'] });
  return {
    kind,
    // Only an ed25519 signer is ever matched against a key. The others are
    // ignored by the rules, so their raw form is enough to identify them.
    key: kind === 'ed25519' ? StrKey.encodeEd25519PublicKey(key.ed25519()) : key.toXDR('hex'),
    weight: signer.weight(),
  };
}

function accountEntryOf(encoded: string): StellarAccountEntry {
  const account = xdr.LedgerEntryData.fromXDR(encoded, 'base64').account();
  // Master weight, then the low, medium and high thresholds, one byte each.
  const [masterWeight = 0, low = 0, medium = 0, high = 0] = account.thresholds();
  return {
    accountId: accountIdText(account.accountId()),
    masterWeight,
    thresholds: { low, medium, high },
    signers: account.signers().map(signerOf),
  };
}

function trustlineEntryOf(encoded: string, asset: StellarAsset): StellarTrustlineEntry {
  const line = xdr.LedgerEntryData.fromXDR(encoded, 'base64').trustLine();
  const ext = line.ext();
  return {
    accountId: accountIdText(line.accountId()),
    asset,
    balance: BigInt(line.balance().toString()),
    limit: BigInt(line.limit().toString()),
    // A trustline that never had liabilities carries no extension.
    buyingLiabilities: ext.switch() === 0 ? 0n : BigInt(ext.v1().liabilities().buying().toString()),
    flags: line.flags(),
  };
}

function entryOf(key: StellarLedgerKey, encoded: string): StellarLedgerEntry {
  try {
    return key.kind === 'account'
      ? { kind: 'account', ...accountEntryOf(encoded) }
      : { kind: 'trustline', ...trustlineEntryOf(encoded, key.asset) };
  } catch (error) {
    // The decoder quotes what it read, so only its kind travels on.
    throw new InvalidInputError({ issues: ['ledgerEntries (invalid)'], cause: error });
  }
}

/**
 * A ledger reader over the RPC. Entries come back in any order and a key
 * with no entry is simply absent, so each is matched by its encoded key.
 */
export function createStellarLedgerReader(
  rpc: Pick<StellarRpc, 'getLedgerEntries'>,
): StellarLedgerReader {
  return {
    async getLedgerEntries(_network, keys, opts: CallOptions) {
      const encoded = keys.map((key) => ({ key, text: keyOf(key) }));
      const { entries } = await rpc.getLedgerEntries(
        encoded.map(({ text }) => text),
        opts,
      );
      const byKey = new Map(entries.map((entry) => [entry.key, entry.xdr]));
      return encoded.map(({ key, text }) => {
        const found = byKey.get(text);
        return found === undefined ? null : entryOf(key, found);
      });
    },
  };
}
