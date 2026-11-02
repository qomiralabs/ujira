// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the chain can carry at all. A Stellar call takes i128 amounts, u64
// times and tags, u32 counts, strkey addresses and 32 byte values, and a tag
// only on an account. A value outside those cannot be encoded, so it is the
// caller's mistake, not something the mandate rules on: it fails as invalid
// input before any check runs. Values inside them reach the mandate's own
// checks unchanged, a negative amount included.

import { InvalidInputError } from '../errors.js';

import { accountKeyOf, checkAddress } from './address.js';
import { isBytes32 } from './bytes.js';
import { I128_MAX, I128_MIN, RECIPIENT_MODES, U32_MAX, U64_MAX } from './spec.js';
import type { RecipientMode } from './spec.js';
import type {
  EngineAllowEntry,
  EngineAttestation,
  EngineConfig,
  EngineDestination,
  EngineLeg,
  EngineLimits,
  EnginePayoutRequest,
  Invocation,
} from './types.js';

function invalid(field: string): InvalidInputError {
  return new InvalidInputError({ issues: [`${field} (invalid)`] });
}

export function i128(field: string, value: unknown): bigint {
  if (typeof value !== 'bigint' || value < I128_MIN || value > I128_MAX) throw invalid(field);
  return value;
}

export function u64(field: string, value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw invalid(field);
  return value;
}

export function u32(field: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > U32_MAX) {
    throw invalid(field);
  }
  return value as number;
}

export function bytes32(field: string, value: unknown): string {
  if (!isBytes32(value)) throw invalid(field);
  return value;
}

export function bytes(field: string, value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw invalid(field);
  return Uint8Array.from(value);
}

export function invocation(inv: Invocation): Invocation {
  checkAddress('caller', inv.caller);
  if (inv.signedBy !== undefined) checkAddress('signedBy', inv.signedBy);
  return inv;
}

export function addresses(field: string, list: readonly string[]): string[] {
  return list.map((a, i) => checkAddress(`${field}.${String(i)}`, a));
}

export function destination(field: string, d: EngineDestination): EngineDestination {
  const address = checkAddress(`${field}.address`, d.address);
  const tag = d.tag === null ? null : u64(`${field}.tag`, d.tag);
  // Only a muxed account carries a tag; a contract address has no muxed form.
  if (tag !== null && accountKeyOf(address) === null) throw invalid(`${field}.tag`);
  return { address, tag };
}

export function legs(list: readonly EngineLeg[]): EngineLeg[] {
  return list.map((leg, i) => ({
    destination: destination(`legs.${String(i)}.destination`, leg.destination),
    amount: i128(`legs.${String(i)}.amount`, leg.amount),
  }));
}

export function limits(l: EngineLimits): EngineLimits {
  return {
    totalBudget: i128('limits.totalBudget', l.totalBudget),
    perPaymentCap: i128('limits.perPaymentCap', l.perPaymentCap),
    perRecipientDailyCap: i128('limits.perRecipientDailyCap', l.perRecipientDailyCap),
    approvalThreshold: i128('limits.approvalThreshold', l.approvalThreshold),
    payoutTtlSeconds: u64('limits.payoutTtlSeconds', l.payoutTtlSeconds),
    expiresAt: u64('limits.expiresAt', l.expiresAt),
  };
}

function recipientMode(value: unknown): RecipientMode {
  if (!(RECIPIENT_MODES as readonly unknown[]).includes(value)) throw invalid('recipientMode');
  return value as RecipientMode;
}

export function config(c: EngineConfig): EngineConfig {
  return {
    principal: checkAddress('principal', c.principal),
    asset: checkAddress('asset', c.asset),
    recipientMode: recipientMode(c.recipientMode),
    tenantTag: bytes32('tenantTag', c.tenantTag),
    agents: addresses('agents', c.agents),
    approvers: addresses('approvers', c.approvers),
    approvalsRequired: u32('approvalsRequired', c.approvalsRequired),
    guardians: addresses('guardians', c.guardians),
    executors: addresses('executors', c.executors),
    recovery: addresses('recovery', c.recovery),
    recoveryThreshold: u32('recoveryThreshold', c.recoveryThreshold),
    limits: limits(c.limits),
    attester: c.attester === null ? null : bytes('attester', c.attester),
    countryPolicyHash: bytes32('countryPolicyHash', c.countryPolicyHash),
    maxFeeBps: u32('maxFeeBps', c.maxFeeBps),
  };
}

function attestation(a: EngineAttestation, i: number): EngineAttestation {
  return {
    validUntil: u64(`attestations.${String(i)}.validUntil`, a.validUntil),
    policyEpoch: u64(`attestations.${String(i)}.policyEpoch`, a.policyEpoch),
    signature: bytes(`attestations.${String(i)}.signature`, a.signature),
  };
}

export interface CheckedRequest {
  readonly payoutId: string;
  readonly recipientRef: string;
  readonly total: bigint;
  readonly fee: bigint;
  readonly legs: readonly EngineLeg[];
  readonly deadline: bigint;
  readonly taskRef: string;
  readonly attestations: readonly EngineAttestation[];
}

export function request(r: EnginePayoutRequest): CheckedRequest {
  return {
    payoutId: bytes32('payoutId', r.payoutId),
    recipientRef: bytes32('recipientRef', r.recipientRef),
    total: i128('total', r.total),
    fee: i128('fee', r.fee ?? 0n),
    legs: legs(r.legs),
    deadline: u64('deadline', r.deadline),
    taskRef: bytes32('taskRef', r.taskRef),
    attestations: r.attestations.map(attestation),
  };
}

export function allowEntries(list: readonly EngineAllowEntry[]): EngineAllowEntry[] {
  return list.map((e, i) => ({
    recipientRef: bytes32(`entries.${String(i)}.recipientRef`, e.recipientRef),
    destination: destination(`entries.${String(i)}.destination`, e.destination),
  }));
}
