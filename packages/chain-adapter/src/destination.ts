// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Destination capture for onboarding and the API, with no chain in the
// call: the network picks the reader from a table, so identity, the API
// and the widget validate a destination the same way without knowing which
// chain it is on.

import { InvalidInputError } from './errors.js';
import { isNetworkId, namespaceOf } from './networks.js';
import type { ChainNamespace, NetworkId } from './networks.js';
import {
  STELLAR_MEMO_TYPES,
  readStellarBindable,
  readStellarDepositInstruction,
} from './stellar/destination.js';
import type { BindableDestination } from './stellar/destination.js';

export { UNSUPPORTED_MEMO_DESTINATION_MESSAGE } from './errors.js';
export type { BindableDestination };

/** The memo types a destination may name. Only none and id can be paid from a mandate. */
export const DESTINATION_MEMO_TYPES = STELLAR_MEMO_TYPES;

export type DestinationMemoType = (typeof DESTINATION_MEMO_TYPES)[number];

/** A destination as a recipient enters it. */
export interface DestinationInput {
  readonly address: string;
  readonly memoType?: DestinationMemoType;
  readonly memo?: string;
}

interface Readers {
  readonly bindable: (network: NetworkId, input: unknown) => BindableDestination;
  readonly instruction: (network: NetworkId, instruction: unknown) => BindableDestination;
}

const READERS: Readonly<Record<ChainNamespace, Readers>> = Object.freeze({
  stellar: { bindable: readStellarBindable, instruction: readStellarDepositInstruction },
});

function readersFor(network: unknown): { network: NetworkId; readers: Readers } {
  if (!isNetworkId(network)) throw new InvalidInputError({ issues: ['network (invalid)'] });
  return { network, readers: READERS[namespaceOf(network)] };
}

/**
 * Reads a destination a recipient entered into what a mandate can bind,
 * and the one address text to store for it. A destination that needs a
 * memo a payout cannot carry throws UnsupportedMemoDestinationError; any
 * other refusal is InvalidInputError with a DestinationParseReason.
 */
export function readBindableDestination(
  network: NetworkId,
  input: DestinationInput,
): BindableDestination {
  const found = readersFor(network);
  return found.readers.bindable(found.network, input);
}

/**
 * Reads where a provider's deposit instructions say to send funds, with
 * the same rules as readBindableDestination.
 */
export function readProviderDepositInstruction(
  network: NetworkId,
  instruction: unknown,
): BindableDestination {
  const found = readersFor(network);
  return found.readers.instruction(found.network, instruction);
}
