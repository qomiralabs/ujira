// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Where a recipient's payout destination is captured during onboarding.
// Which destinations a mandate can pay is the chain adapter's rule, so this
// asks the adapter and turns its answer into the record onboarding stores.
// A destination that needs a text or hash memo is refused here, when the
// recipient can still choose another method, rather than at payout time.

import { readBindableDestination, readProviderDepositInstruction } from '@ujira/chain-adapter';
import type { BindableDestination, DestinationInput, NetworkId } from '@ujira/chain-adapter';

export interface CapturedDestination {
  readonly network: NetworkId;
  /** The one text to store and show for it, with any numeric memo carried inside. */
  readonly address: string;
  /** The tag in decimal, or null. Text, so it survives JSON at full width. */
  readonly tag: string | null;
}

function captured(network: NetworkId, read: BindableDestination): CapturedDestination {
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
 * another method.
 */
export function captureDestination(
  network: NetworkId,
  input: DestinationInput,
): CapturedDestination {
  return captured(network, readBindableDestination(network, input));
}

/**
 * Captures where a provider's deposit instructions say to send funds, under
 * the same rule: instructions that need a text or hash memo are refused.
 */
export function captureProviderDestination(
  network: NetworkId,
  instruction: unknown,
): CapturedDestination {
  return captured(network, readProviderDepositInstruction(network, instruction));
}
