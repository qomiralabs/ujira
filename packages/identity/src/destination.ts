// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Where a recipient's payout destination is captured during onboarding.
// Which destinations a mandate can pay is the chain adapter's rule, so this
// asks the adapter and turns its answer into the record onboarding stores.
// A destination that needs a text or hash memo is refused here, when the
// recipient can still choose another method, rather than at payout time.
// So is one that can never pay out. A transfer to an asset's issuer is burned
// and the mandate does not stop it, so it must not get this far.

import {
  InvalidInputError,
  isUnpayableAddress,
  readBindableDestination,
  readProviderDepositInstruction,
} from '@ujira/chain-adapter';
import type { BindableDestination, DestinationInput, NetworkId } from '@ujira/chain-adapter';

export interface CapturedDestination {
  readonly network: NetworkId;
  /** The one text to store and show for it, with any numeric memo carried inside. */
  readonly address: string;
  /** The tag in decimal, or null. Text, so it survives JSON at full width. */
  readonly tag: string | null;
}

function captured(
  network: NetworkId,
  neverPayable: readonly string[],
  read: BindableDestination,
): CapturedDestination {
  if (isUnpayableAddress(read.address, neverPayable)) {
    throw new InvalidInputError({
      network,
      reason: 'UNPAYABLE_ADDRESS',
      issues: ['address (unpayable_address)'],
    });
  }
  const { tag } = read.destination;
  return Object.freeze({
    network,
    address: read.address,
    tag: tag === null ? null : tag.toString(),
  });
}

/**
 * Captures a destination a recipient entered. Throws the adapter's
 * UnsupportedMemoDestinationError for one that needs a text or hash memo,
 * and InvalidInputError for any other refusal, so the caller can ask for
 * another method. `neverPayable` is what the network settles through, from
 * settlementAddressesOf, and is required so no caller can leave the rule out.
 */
export function captureDestination(
  network: NetworkId,
  neverPayable: readonly string[],
  input: DestinationInput,
): CapturedDestination {
  return captured(network, neverPayable, readBindableDestination(network, input));
}

/**
 * Captures where a provider's deposit instructions say to send funds, under
 * the same rules: instructions that need a text or hash memo, or that name
 * an address that can never pay out, are refused.
 */
export function captureProviderDestination(
  network: NetworkId,
  neverPayable: readonly string[],
  instruction: unknown,
): CapturedDestination {
  return captured(network, neverPayable, readProviderDepositInstruction(network, instruction));
}
