// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// An attestation binds a destination the mandate then pays on the attester's
// word, so the attester never signs for an address that can never pay out:
// the mandate it would sign for, that mandate's settlement asset contract, or
// an all-zero address. The mandate refuses such a leg anyway, but only after
// an agent has paid for the failed request, and the attester is the one party
// that sees the destination before it is bound.
//
// The fields say whether the destination is the mandate or all zeros. The
// asset is not among them, because the message does not cover it and a
// caller's word for it would prove nothing, so it comes from the index.

import { DestinationInvalidError, SignerDeniedError } from '@ujira/chain-adapter';
import type { AttestationFields, CallOptions, NetworkId } from '@ujira/chain-adapter';
import { isZeroAddress } from '@ujira/chain-adapter/codecs';

/** Where an attester reads what a mandate settles in. */
export interface SettlementAssetIndex {
  /** The mandate at `contract` on `network` when it is indexed, else null. */
  find(
    network: NetworkId,
    contract: string,
    opts: CallOptions,
  ): Promise<{ readonly settlementAsset: string } | null>;
}

/** What the fields alone can show: the destination is the mandate, or all zeros. */
export function refuseUnpayable(fields: AttestationFields): void {
  const destination = fields.destination.address.value;
  if (destination === fields.mandate.address.value || isZeroAddress(destination)) {
    throw new DestinationInvalidError({ network: fields.mandate.network });
  }
}

/** The destination is the contract of the asset this mandate settles in. */
export function refuseSettlementAsset(fields: AttestationFields, settlementAsset: string): void {
  if (fields.destination.address.value === settlementAsset) {
    throw new DestinationInvalidError({ network: fields.mandate.network });
  }
}

/**
 * The whole rule, for a backend that signs an attestation with no service in
 * front of it. A mandate the index does not know is denied: its asset cannot
 * be ruled out, and nothing should be attested for it anyway.
 */
export async function checkPayable(
  fields: AttestationFields,
  mandates: SettlementAssetIndex,
  opts: CallOptions,
): Promise<void> {
  refuseUnpayable(fields);
  const { network, address } = fields.mandate;
  const mandate = await mandates.find(network, address.value, opts);
  if (mandate === null) throw new SignerDeniedError({ network });
  refuseSettlementAsset(fields, mandate.settlementAsset);
}
