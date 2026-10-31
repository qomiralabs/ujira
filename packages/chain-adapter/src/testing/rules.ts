// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The configuration rules a mandate applies at creation and again on every
// later change, kept in one place so create, the constructor and the
// administrative calls can never disagree on a domain or a role conflict.

import { accountKeyOf } from './address.js';
import { equalBytes } from './bytes.js';
import { refusal } from './failures.js';
import {
  ATTESTER_KEY_BYTES,
  BPS_DENOMINATOR,
  MAX_AGENTS,
  MAX_APPROVERS,
  MAX_EXECUTORS,
  MAX_FEE_BPS,
  MAX_GUARDIANS,
  MAX_RECOVERY,
  PAYOUT_TTL_MAX,
  PAYOUT_TTL_MIN,
  ROLE,
} from './spec.js';
import type { RecipientMode, RoleCode } from './spec.js';
import type { EngineConfig, EngineLimits } from './types.js';

export const ROLE_BOUND: Readonly<Record<RoleCode, number>> = Object.freeze({
  [ROLE.AGENT]: MAX_AGENTS,
  [ROLE.APPROVER]: MAX_APPROVERS,
  [ROLE.GUARDIAN]: MAX_GUARDIANS,
  [ROLE.EXECUTOR]: MAX_EXECUTORS,
  [ROLE.RECOVERY]: MAX_RECOVERY,
});

// The role sets each role must stay apart from: agents from approvers,
// executors and recovery approvers; approvers from agents and executors;
// executors from approvers, agents and recovery approvers; recovery
// approvers from agents and executors. A guardian may hold any other role.
const DISJOINT: Readonly<Record<RoleCode, readonly RoleCode[]>> = Object.freeze({
  [ROLE.AGENT]: [ROLE.APPROVER, ROLE.RECOVERY, ROLE.EXECUTOR],
  [ROLE.APPROVER]: [ROLE.AGENT, ROLE.EXECUTOR],
  [ROLE.GUARDIAN]: [],
  [ROLE.EXECUTOR]: [ROLE.APPROVER, ROLE.RECOVERY, ROLE.AGENT],
  [ROLE.RECOVERY]: [ROLE.AGENT, ROLE.EXECUTOR],
});

// The principal may also approve or guard, never spend, submit or vote.
const NEVER_PRINCIPAL: ReadonlySet<RoleCode> = new Set([ROLE.AGENT, ROLE.EXECUTOR, ROLE.RECOVERY]);

export function isRoleCode(code: number): code is RoleCode {
  return Number.isInteger(code) && code >= ROLE.AGENT && code <= ROLE.RECOVERY;
}

/** The role sets of a configuration, by role code. */
export type RoleSets = Readonly<Record<RoleCode, readonly string[]>>;

/**
 * Whether `account` may join `role` beside the current sets, the principal
 * and the fee address. The fee address holds no role at all.
 */
export function joinConflicts(
  role: RoleCode,
  account: string,
  sets: RoleSets,
  principal: string,
  feeAddress: string,
): boolean {
  return (
    account === feeAddress ||
    (NEVER_PRINCIPAL.has(role) && account === principal) ||
    DISJOINT[role].some((other) => sets[other].includes(account))
  );
}

/** The domains of the six limits and an expiry still ahead. */
export function limitsValid(l: EngineLimits, now: bigint): boolean {
  return (
    l.totalBudget >= 1n &&
    l.perPaymentCap >= 1n &&
    l.perPaymentCap <= l.totalBudget &&
    l.perRecipientDailyCap >= 1n &&
    l.approvalThreshold >= 0n &&
    l.payoutTtlSeconds >= PAYOUT_TTL_MIN &&
    l.payoutTtlSeconds <= PAYOUT_TTL_MAX &&
    l.expiresAt > now
  );
}

/** A 32 byte value that is not all zero; whether it is a usable point is checked off chain. */
export function attesterWellFormed(key: Uint8Array): boolean {
  return key.length === ATTESTER_KEY_BYTES && key.some((byte) => byte !== 0);
}

/** An attester exactly when the mode needs one, and well formed. */
export function attesterFitsMode(mode: RecipientMode, attester: Uint8Array | null): boolean {
  if (mode === 'ALLOWLIST') return attester === null;
  return attester !== null && attesterWellFormed(attester);
}

/**
 * Whether the attester key is the ed25519 key of one of these accounts. A
 * contract address has no such key and never matches.
 */
export function keyHeldBy(key: Uint8Array, accounts: readonly string[]): boolean {
  return accounts.some((account) => {
    const own = accountKeyOf(account);
    return own !== null && equalBytes(own, key);
  });
}

/** With no approvers nothing may need an approval; otherwise 1 to the number of approvers. */
export function approvalsFit(required: number, approvers: number, limits: EngineLimits): boolean {
  if (approvers === 0) return required === 0 && limits.approvalThreshold > limits.perPaymentCap;
  return required >= 1 && required <= approvers;
}

/** 0 exactly when the recovery set is empty, otherwise 1 to its size. */
export function recoveryFits(threshold: number, members: number): boolean {
  if (members === 0) return threshold === 0;
  return threshold >= 1 && threshold <= members;
}

/** floor(total * bps / 10000) without ever forming total * bps. */
export function feeCap(total: bigint, maxFeeBps: number): bigint {
  const bps = BigInt(maxFeeBps);
  return (total / BPS_DENOMINATOR) * bps + ((total % BPS_DENOMINATOR) * bps) / BPS_DENOMINATOR;
}

function hasRepeat(list: readonly string[]): boolean {
  return new Set(list).size !== list.length;
}

function setsOf(c: EngineConfig): RoleSets {
  return {
    [ROLE.AGENT]: c.agents,
    [ROLE.APPROVER]: c.approvers,
    [ROLE.GUARDIAN]: c.guardians,
    [ROLE.EXECUTOR]: c.executors,
    [ROLE.RECOVERY]: c.recovery,
  };
}

const ROLE_CODES: readonly RoleCode[] = [
  ROLE.AGENT,
  ROLE.APPROVER,
  ROLE.GUARDIAN,
  ROLE.EXECUTOR,
  ROLE.RECOVERY,
];

/**
 * Checks 3 to 16 of create, in order, as the factory runs them before it
 * deploys and the constructor runs them again. The first failure decides.
 */
export function validateConfig(c: EngineConfig, feeAddress: string, now: bigint): void {
  const sets = setsOf(c);
  // A role list is a set: a repeated member would count twice toward a
  // gate and stay behind after one removal.
  if (
    !limitsValid(c.limits, now) ||
    c.maxFeeBps > MAX_FEE_BPS ||
    ROLE_CODES.some((role) => hasRepeat(sets[role]))
  ) {
    throw refusal('CONFIG_INVALID');
  }
  if (!attesterFitsMode(c.recipientMode, c.attester)) throw refusal('CONFIG_INVALID');
  const conflict = ROLE_CODES.some((role) =>
    sets[role].some((account) => joinConflicts(role, account, sets, c.principal, feeAddress)),
  );
  if (conflict || c.principal === feeAddress) throw refusal('ROLE_CONFLICT');
  const everyone = [c.principal, feeAddress, ...ROLE_CODES.flatMap((role) => sets[role])];
  if (c.attester !== null && keyHeldBy(c.attester, everyone)) throw refusal('ROLE_CONFLICT');
  if (ROLE_CODES.some((role) => sets[role].length > ROLE_BOUND[role])) {
    throw refusal('ROLE_SET_FULL');
  }
  if (!approvalsFit(c.approvalsRequired, c.approvers.length, c.limits)) {
    throw refusal('CONFIG_INVALID');
  }
  if (!recoveryFits(c.recoveryThreshold, c.recovery.length)) throw refusal('CONFIG_INVALID');
}
