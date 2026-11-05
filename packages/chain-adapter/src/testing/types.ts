// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The shapes the in-memory mandate takes and answers with. Amounts, times,
// tags and the policy epoch are bigint, never a float; counts, codes and
// basis points are small integers. Addresses are G or C strkeys and 32 byte
// values are 0x and 64 lower case hex characters.

import type {
  MandateErrorName,
  OpenStatus,
  PayoutStatus,
  RecipientMode,
  TerminalStatus,
} from './spec.js';

/**
 * Who makes a call and who signs it. For a call that takes a caller
 * argument, `caller` is that argument; for one that does not, it is the
 * address whose authorization the call carries. `signedBy` defaults to the
 * caller and lets a test sign as someone else, which the host refuses.
 */
export interface Invocation {
  readonly caller: string;
  readonly signedBy?: string;
}

/** An address and an optional tag; equal only when both are, the tag's presence included. */
export interface EngineDestination {
  readonly address: string;
  readonly tag: bigint | null;
}

export interface EngineLeg {
  readonly destination: EngineDestination;
  readonly amount: bigint;
}

export interface EngineLimits {
  readonly totalBudget: bigint;
  readonly perPaymentCap: bigint;
  readonly perRecipientDailyCap: bigint;
  readonly approvalThreshold: bigint;
  readonly payoutTtlSeconds: bigint;
  readonly expiresAt: bigint;
}

/** What a principal passes to create. The fee address comes from the factory. */
export interface EngineConfig {
  readonly principal: string;
  readonly asset: string;
  readonly recipientMode: RecipientMode;
  readonly tenantTag: string;
  readonly agents: readonly string[];
  readonly approvers: readonly string[];
  readonly approvalsRequired: number;
  readonly guardians: readonly string[];
  readonly executors: readonly string[];
  readonly recovery: readonly string[];
  readonly recoveryThreshold: number;
  readonly limits: EngineLimits;
  /** Raw bytes, so a key of the wrong length can reach the mandate's own check. */
  readonly attester: Uint8Array | null;
  readonly countryPolicyHash: string;
  readonly maxFeeBps: number;
}

export interface EngineAttestation {
  readonly validUntil: bigint;
  readonly policyEpoch: bigint;
  /** Raw bytes, so a signature of the wrong length reaches the mandate's own check. */
  readonly signature: Uint8Array;
}

export interface EnginePayoutRequest {
  readonly payoutId: string;
  readonly recipientRef: string;
  readonly total: bigint;
  /** Defaults to 0. */
  readonly fee?: bigint;
  readonly legs: readonly EngineLeg[];
  readonly deadline: bigint;
  readonly taskRef: string;
  /** One per leg, in leg order, in ATTESTED and BOTH modes; none in ALLOWLIST mode. */
  readonly attestations: readonly EngineAttestation[];
}

/** One item of a request or cancel batch: no error and a status, or the item's own error. */
export interface EngineItemResult {
  readonly payoutId: string;
  readonly error: MandateErrorName | null;
  readonly status: PayoutStatus | null;
}

export interface EngineAllowEntry {
  readonly recipientRef: string;
  readonly destination: EngineDestination;
}

export interface EngineStateView {
  readonly spent: bigint;
  readonly pending: bigint;
  readonly committed: bigint;
  readonly balance: bigint;
  readonly free: bigint;
  readonly paused: boolean;
  readonly revoked: boolean;
  readonly expired: boolean;
  readonly policyEpoch: bigint;
}

export interface EngineConfigView extends EngineConfig {
  readonly factory: string;
  readonly feeAddress: string;
  readonly proposedPrincipal: string | null;
  readonly recoveryEpoch: number;
  readonly agentEpoch: number;
  readonly approverEpoch: number;
}

/** An approval counts only while its approver still holds this epoch. */
export interface EngineApproval {
  readonly approver: string;
  readonly epoch: number;
}

export interface EnginePayoutRecord {
  readonly payoutId: string;
  readonly status: OpenStatus;
  readonly agent: string;
  readonly agentEpoch: number;
  readonly recipientRef: string;
  readonly total: bigint;
  readonly fee: bigint;
  readonly legs: readonly EngineLeg[];
  readonly createdAt: bigint;
  readonly expiresAt: bigint;
  readonly policyEpoch: bigint;
  readonly approvals: readonly EngineApproval[];
}

export interface EngineTombstone {
  readonly payoutId: string;
  readonly status: TerminalStatus;
}

export type EnginePayoutView = EnginePayoutRecord | EngineTombstone;

export interface EngineDailyUsage {
  readonly day: bigint;
  readonly used: bigint;
}

/** A field value of an event in the spec's canonical form. */
export type EventValue =
  | bigint
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | readonly EventValue[]
  | { readonly [field: string]: EventValue };

/**
 * An event in the spec's canonical form: the event name and its snake_case
 * fields, the topic key included. Statuses, recipient modes and error codes
 * are their names.
 */
export interface EngineEvent {
  /** The contract that emitted it: the mandate or the factory. */
  readonly contract: string;
  readonly name: string;
  readonly fields: Readonly<Record<string, EventValue>>;
}

/** A token's own event, which the mandate never emits and never reads. */
export interface TokenEvent {
  readonly token: string;
  readonly name: 'transfer' | 'mint' | 'clawback';
  readonly from: string | null;
  readonly to: EngineDestination | null;
  readonly amount: bigint;
}
