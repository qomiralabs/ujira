// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the sweep worker asks of a chain. Declared here rather than beside the one
// implementation, so the worker and the chain module compile against the same
// contract and neither can drift from the other.

import type { TokenAmount } from '@ujira/core';

export interface SweepTransferEvent {
  readonly eventIndex: number;
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly amount: TokenAmount;
}

/** What the network says of a hash. `failed` and `landed` name the ledger that applied it. */
export type SweepChainResult =
  | {
      readonly kind: 'not_found';
      /**
       * When the oldest ledger this node still holds closed, or null if it did not
       * say. Not found proves nothing about anything older than this, because a
       * transaction past the node's window reads the same as one that never existed.
       */
      readonly recordsSince: Date | null;
    }
  | {
      readonly kind: 'landed';
      readonly ledger: number;
      readonly transfers: readonly SweepTransferEvent[];
    }
  | {
      readonly kind: 'failed';
      readonly ledger: number;
      readonly reason: 'insufficient_balance' | 'rejected';
    };

/** What a signed envelope itself says, so nothing about it is taken on trust. */
export interface SweepEnvelope {
  /** Hex. */
  readonly txHash: string;
  /** The last moment it can be applied, from its time bounds. */
  readonly validUntil: Date;
  /** The ledger its signed authorization entry expires at, or null when it has none. */
  readonly authExpiresLedger: number | null;
}

/** The chain adapter's side of a sweep. */
export interface SweepChain {
  /** Throws for an envelope with no upper time bound. */
  describe(signedPayload: string): SweepEnvelope;
  send(signedPayload: string, signal: AbortSignal): Promise<void>;
  result(txHash: string, signal: AbortSignal): Promise<SweepChainResult>;
  latestLedger(signal: AbortSignal): Promise<number>;
}
