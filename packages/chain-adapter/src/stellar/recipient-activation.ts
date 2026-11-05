// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Recipients never need XLM. When a destination has no account, or no
// trustline for the payout asset, UJIRA's fee sponsor pays the reserves and
// the fee: one transaction with the sponsor as source and fee payer that
// begins sponsoring, creates the account at a zero balance when it is
// missing, adds the trustline as the recipient, and ends the sponsorship as
// the recipient. The recipient's wallet signs first; the sponsor signs last,
// through the signer port, when the transaction is submitted.

import { Account, Asset, Operation, TransactionBuilder } from '@stellar/stellar-base';

import { networkPassphrase } from '../codecs/network.js';
import { isAccountAddress } from '../codecs/strkey.js';
import { InvalidInputError, UnsupportedError } from '../errors.js';
import type { StellarNetworkId } from '../networks.js';
import type { SigningRequest, UnixSeconds } from '../types.js';
import type { StellarAsset } from './account-rules.js';
import { parseStellarDestination } from './parse-destination.js';

/** How long the recipient has to sign before the transaction can no longer land. */
export const ACTIVATION_VALIDITY_SECONDS = 300n;

const INT64_MAX = 2n ** 63n - 1n;
const ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;

export interface StellarRecipientActivationRequest {
  readonly requestId: string;
  /** The fee sponsor's G, the transaction source and fee payer. */
  readonly sponsor: string;
  /** The sponsor account's current sequence number. */
  readonly sponsorSequence: bigint;
  /** The destination as the recipient gave it, a G or an M. */
  readonly recipient: string;
  readonly asset: StellarAsset;
  /** True when the destination account does not exist yet. */
  readonly createAccount: boolean;
  /** The base fee per operation, in stroops. */
  readonly baseFeeStroops: bigint;
  /** The most one transaction may cost, from the fee sponsor config. */
  readonly maxFeePerTxStroops: bigint;
  readonly nowSeconds: bigint;
}

function refuse(field: string, code: string): InvalidInputError {
  return new InvalidInputError({ issues: [`activation.${field} (${code})`] });
}

function inRange(value: bigint, min: bigint, max: bigint): boolean {
  return typeof value === 'bigint' && value >= min && value <= max;
}

/**
 * Builds the sponsorship transaction for a recipient and returns it as a
 * signing request for the recipient's wallet. Throws UnsupportedError when
 * the network has no reserve sponsorship, and InvalidInputError for a
 * request that could never land: a contract or the sponsor as recipient,
 * an asset that is not a classic asset, or a fee above the sponsor's cap.
 */
export function buildRecipientActivation(
  network: StellarNetworkId,
  req: StellarRecipientActivationRequest,
  capabilities: { readonly reserveSponsorship: boolean },
): Extract<SigningRequest, { readonly kind: 'stellar_transaction' }> {
  if (!capabilities.reserveSponsorship) throw new UnsupportedError({ network });
  if (!isAccountAddress(req.sponsor)) throw refuse('sponsor', 'invalid');
  const recipient = parseStellarDestination(network, { address: req.recipient }).address.value;
  // A contract holds any asset without a trustline, so it needs no activation.
  if (!isAccountAddress(recipient)) throw refuse('recipient', 'not_an_account');
  if (recipient === req.sponsor) throw refuse('recipient', 'is_sponsor');
  if (!ASSET_CODE.test(req.asset.code) || !isAccountAddress(req.asset.issuer)) {
    throw refuse('asset', 'invalid');
  }
  if (recipient === req.asset.issuer) throw refuse('recipient', 'is_issuer');
  if (!inRange(req.sponsorSequence, 0n, INT64_MAX - 1n)) throw refuse('sponsorSequence', 'invalid');
  if (!inRange(req.nowSeconds, 0n, INT64_MAX - ACTIVATION_VALIDITY_SECONDS)) {
    throw refuse('nowSeconds', 'invalid');
  }
  const operations = req.createAccount ? 4n : 3n;
  if (!inRange(req.baseFeeStroops, 100n, 4_294_967_295n)) {
    throw refuse('baseFeeStroops', 'out_of_range');
  }
  if (req.baseFeeStroops * operations > req.maxFeePerTxStroops) {
    throw refuse('baseFeeStroops', 'over_cap');
  }
  const validUntil = req.nowSeconds + ACTIVATION_VALIDITY_SECONDS;
  const builder = new TransactionBuilder(new Account(req.sponsor, req.sponsorSequence.toString()), {
    fee: req.baseFeeStroops.toString(),
    networkPassphrase: networkPassphrase(network),
    timebounds: { minTime: req.nowSeconds.toString(), maxTime: validUntil.toString() },
  }).addOperation(
    Operation.beginSponsoringFutureReserves({ sponsoredId: recipient, source: req.sponsor }),
  );
  if (req.createAccount) {
    builder.addOperation(
      Operation.createAccount({
        destination: recipient,
        startingBalance: '0',
        source: req.sponsor,
      }),
    );
  }
  const xdr = builder
    .addOperation(
      Operation.changeTrust({
        asset: new Asset(req.asset.code, req.asset.issuer),
        source: recipient,
      }),
    )
    .addOperation(Operation.endSponsoringFutureReserves({ source: recipient }))
    .build()
    .toXDR();
  return {
    kind: 'stellar_transaction',
    network,
    xdr,
    signer: { network, value: recipient },
    validUntil: validUntil as UnixSeconds,
    sponsored: true,
    summary: { action: 'activate_recipient', feePaidBy: 'ujira' },
    requestId: req.requestId,
  };
}
