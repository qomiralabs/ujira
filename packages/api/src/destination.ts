// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A destination submitted to the API, read with the same capture
// onboarding uses, so a recipient endpoint can never accept what the widget
// refuses. The body schema checks shape only; which destinations a mandate
// can pay is decided by the capture, and a refusal becomes a 422 in
// errors.ts.

import { DESTINATION_MEMO_TYPES, NETWORK_IDS } from '@ujira/chain-adapter';
import { captureDestination } from '@ujira/identity';
import type { CapturedDestination } from '@ujira/identity';
import { z } from 'zod';

/** A destination in a request body. */
export const RecipientDestinationBody = z.strictObject({
  network: z.enum(NETWORK_IDS),
  address: z.string().min(1).max(128),
  memoType: z.enum(DESTINATION_MEMO_TYPES).optional(),
  memo: z.string().max(128).optional(),
});

export type RecipientDestinationBody = z.infer<typeof RecipientDestinationBody>;

/**
 * The destination to store for a validated body. Throws the adapter's
 * UnsupportedMemoDestinationError or InvalidInputError, which the pipeline
 * answers as DESTINATION_INVALID. `neverPayable` is what the body's network
 * settles through, from settlementAddressesOf.
 */
export function readRecipientDestination(
  body: RecipientDestinationBody,
  neverPayable: readonly string[],
): CapturedDestination {
  const { network, address, memoType, memo } = body;
  return captureDestination(network, neverPayable, {
    address,
    ...(memoType === undefined ? {} : { memoType }),
    ...(memo === undefined ? {} : { memo }),
  });
}
