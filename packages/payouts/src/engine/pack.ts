// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// How many payouts go in one call. A request batch is limited by items. An execute batch
// is atomic and limited by transfers too, because each leg is a transfer and so is a fee
// above zero. Order is kept, so what was asked first goes first.

import { BATCH_LIMITS } from '@ujira/chain-adapter';

export interface Transfers {
  readonly legs: number;
  readonly fee: bigint;
}

export const transfersOf = (item: Transfers): number => item.legs + (item.fee > 0n ? 1 : 0);

export function packRequests<T>(items: readonly T[]): readonly (readonly T[])[] {
  const packs: T[][] = [];
  for (let at = 0; at < items.length; at += BATCH_LIMITS.maxBatch) {
    packs.push(items.slice(at, at + BATCH_LIMITS.maxBatch));
  }
  return packs;
}

export function packExecutes<T>(
  items: readonly T[],
  measure: (item: T) => Transfers,
): readonly (readonly T[])[] {
  const packs: T[][] = [];
  let current: T[] = [];
  let transfers = 0;
  for (const item of items) {
    const adding = transfersOf(measure(item));
    const full =
      current.length === BATCH_LIMITS.maxBatch ||
      transfers + adding > BATCH_LIMITS.maxBatchTransfers;
    if (full && current.length > 0) {
      packs.push(current);
      current = [];
      transfers = 0;
    }
    current.push(item);
    transfers += adding;
  }
  if (current.length > 0) packs.push(current);
  return packs;
}
