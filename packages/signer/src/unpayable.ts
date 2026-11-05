// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// An attestation binds a destination the mandate then pays on the attester's
// word, so the attester never signs for an address that can never pay out:
// the mandate it would sign for, the factory that deployed it, its settlement
// asset contract, that asset's issuer account, or an all-zero address. The
// mandate refuses most of these anyway, but only after an agent has paid for
// the failed request, and the attester is the one party that sees the
// destination before it is bound. The issuer is different: a transfer to it
// burns the amount and the mandate does not check for it, so here is the only
// guard.
//
// Every comparison is on the base address, so a tag or an M address over the
// same account changes nothing. The fields say whether the destination is the
// mandate or all zeros. The factory, asset and issuer are not among them,
// because the message does not cover them and a caller's word for them would
// prove nothing, so they come from the index.

import {
  DestinationInvalidError,
  SignerDeniedError,
  isUnpayableAddress,
} from '@ujira/chain-adapter';
import type { AttestationFields, CallOptions, NetworkId } from '@ujira/chain-adapter';

/** What a mandate pays through, none of which can ever pay anyone out. */
export interface MandateSettlement {
  /** The factory that deployed the mandate. It has no call that moves tokens. */
  readonly factory: string;
  /** The contract of the asset the mandate settles in. */
  readonly settlementAsset: string;
  /** That asset's issuer account, where a transfer of the asset is burned. */
  readonly assetIssuer: string;
}

/** Where an attester reads what a mandate settles through. */
export interface MandateSettlementIndex {
  /** The mandate at `contract` on `network` when it is indexed, else null. */
  find(network: NetworkId, contract: string, opts: CallOptions): Promise<MandateSettlement | null>;
}

function refuse(fields: AttestationFields): never {
  throw new DestinationInvalidError({ network: fields.mandate.network });
}

/** What the fields alone can show: the destination is the mandate, or all zeros. */
export function refuseUnpayable(fields: AttestationFields): void {
  const { destination, mandate } = fields;
  if (isUnpayableAddress(destination.address.value, [mandate.address.value])) refuse(fields);
}

/** The destination is the mandate's factory, its settlement asset or that asset's issuer. */
export function refuseSettlement(fields: AttestationFields, settlement: MandateSettlement): void {
  const { factory, settlementAsset, assetIssuer } = settlement;
  const neverPayable = [factory, settlementAsset, assetIssuer];
  if (isUnpayableAddress(fields.destination.address.value, neverPayable)) refuse(fields);
}

/**
 * The whole rule, for a backend that signs an attestation with no service in
 * front of it. A mandate the index does not know is denied: what it settles
 * through cannot be ruled out, and nothing should be attested for it anyway.
 */
export async function checkPayable(
  fields: AttestationFields,
  mandates: MandateSettlementIndex,
  opts: CallOptions,
): Promise<void> {
  refuseUnpayable(fields);
  const { network, address } = fields.mandate;
  const mandate = await mandates.find(network, address.value, opts);
  if (mandate === null) throw new SignerDeniedError({ network });
  refuseSettlement(fields, mandate);
}
