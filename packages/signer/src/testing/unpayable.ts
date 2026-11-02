// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The destinations a mandate could never pay out to, and a mandate index that
// knows the one of them that varies by mandate, for every test of the rule.

import type { AttestationFields, Bytes32, NetworkId, UnixSeconds } from '@ujira/chain-adapter';
import {
  ZERO_ACCOUNT_ADDRESS,
  ZERO_CONTRACT_ADDRESS,
  encodeMuxedAddress,
} from '@ujira/chain-adapter/codecs';
import { TEST_CONTRACT, TEST_DESTINATION, contractAddress } from '@ujira/chain-adapter/testing';

import type { SettlementAssetIndex } from '../unpayable.js';

const NETWORK: NetworkId = 'stellar:testnet';

/** The settlement asset contract of the mandate at TEST_CONTRACT. */
export const TEST_ASSET = contractAddress(new Uint8Array(32).fill(0xa5));
/** A contract that is neither the mandate nor its asset, so it can be paid. */
export const PAYABLE_CONTRACT = contractAddress(new Uint8Array(32).fill(0x7c));

/** Knows the mandate at TEST_CONTRACT and no other. */
export const TEST_MANDATES: SettlementAssetIndex = {
  find: (_network, contract) =>
    Promise.resolve(contract === TEST_CONTRACT ? { settlementAsset: TEST_ASSET } : null),
};

export type DestinationCase = readonly [label: string, address: string, tag: bigint | null];

/** Refused from the fields alone, so every backend can tell. */
export const UNPAYABLE_FROM_FIELDS: readonly DestinationCase[] = [
  ['the mandate', TEST_CONTRACT, null],
  ['the mandate with a tag', TEST_CONTRACT, 7n],
  ['the all-zero account', ZERO_ACCOUNT_ADDRESS, null],
  ['the all-zero account with a tag', ZERO_ACCOUNT_ADDRESS, 7n],
  ['the all-zero account as an M address', encodeMuxedAddress(new Uint8Array(32), 7n), null],
  ['the all-zero contract', ZERO_CONTRACT_ADDRESS, null],
];

/** Everything refused, the one that needs the mandate index included. */
export const UNPAYABLE: readonly DestinationCase[] = [
  ...UNPAYABLE_FROM_FIELDS,
  ['the settlement asset contract', TEST_ASSET, null],
  ['the settlement asset contract with a tag', TEST_ASSET, 7n],
];

export const PAYABLE: readonly DestinationCase[] = [
  ['an account', TEST_DESTINATION, null],
  ['an account with a tag', TEST_DESTINATION, 7n],
  ['a contract', PAYABLE_CONTRACT, null],
];

/** An attestation on the mandate at TEST_CONTRACT for this destination. */
export function attestationTo(address: string, tag: bigint | null): AttestationFields {
  return {
    mandate: {
      network: NETWORK,
      address: { network: NETWORK, value: TEST_CONTRACT },
      specVersion: 1,
    },
    recipientRef: `0x${'11'.repeat(32)}` as Bytes32,
    countryPolicyHash: `0x${'22'.repeat(32)}` as Bytes32,
    policyEpoch: 3n,
    validUntil: 1_900_003_600n as UnixSeconds,
    destination: { address: { network: NETWORK, value: address }, tag },
  };
}
