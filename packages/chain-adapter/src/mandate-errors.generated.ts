// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generated from spec/errors.json by src/mandate-errors.test.ts. Do not edit
// by hand: update the vendored file, then run
// `pnpm --filter @ujira/chain-adapter errors:generate`.

/** Every mandate error by its spec name, with its code. Codes are never reused. */
export const MANDATE_ERRORS = Object.freeze({
  /** The caller does not hold a role this call allows */
  UNAUTHORIZED: 10,
  /** An address would hold two roles that must stay apart */
  ROLE_CONFLICT: 11,
  /** A role set would exceed its bound */
  ROLE_SET_FULL: 12,
  /** The mandate is revoked */
  MANDATE_REVOKED: 20,
  /** The mandate is expired */
  MANDATE_EXPIRED: 21,
  /** The mandate is paused */
  MANDATE_PAUSED: 22,
  /** Pause while paused */
  ALREADY_PAUSED: 23,
  /** Resume while not paused */
  NOT_PAUSED: 24,
  /** Sweep while the mandate is active */
  MANDATE_ACTIVE: 25,
  /** A third-party sweep while a principal change is proposed */
  PRINCIPAL_CHANGE_PENDING: 26,
  /** A third-party sweep within the grace after expiry */
  SWEEP_GRACE_PERIOD: 27,
  /** An amount outside its domain */
  AMOUNT_INVALID: 30,
  /** Leg count, leg amount, zero address, tag form or duplicate destination */
  LEGS_INVALID: 31,
  /** Legs do not sum to the total */
  LEGS_SUM_MISMATCH: 32,
  /** Batch length or transfer budget out of bounds */
  BATCH_INVALID: 33,
  /** A configuration value or change is not allowed, including an attester key that is not 32 bytes or is 32 zero bytes */
  CONFIG_INVALID: 34,
  /** The request arrived at or after its deadline */
  REQUEST_DEADLINE_PASSED: 35,
  /** The charge exceeds the remaining budget */
  BUDGET_EXCEEDED: 40,
  /** The charge exceeds the per-payment cap */
  PAYMENT_CAP_EXCEEDED: 41,
  /** The total exceeds the recipient's daily headroom */
  DAILY_CAP_EXCEEDED: 42,
  /** The charge exceeds the free balance or the balance */
  INSUFFICIENT_FUNDS: 43,
  /** A new budget below what is already reserved or spent */
  BUDGET_BELOW_RESERVED: 44,
  /** Sweep with a zero balance */
  NOTHING_TO_SWEEP: 45,
  /** The fee exceeds the fee cap for the total */
  FEE_EXCEEDS_CAP: 46,
  /** A leg destination is not on the allowlist for the recipient */
  RECIPIENT_NOT_ALLOWED: 50,
  /** An attestation where none is allowed, the wrong number of attestations, a window longer than MAX_ATTESTATION_VALIDITY, or a signature that is not 64 bytes. A wrongly signed attestation is a host trap on Stellar, not this code (MANDATE-RECIPIENT-012) */
  ATTESTATION_INVALID: 51,
  /** An attestation at or after its valid_until */
  ATTESTATION_EXPIRED: 52,
  /** The mandate's policy epoch differs from the epoch the attestation was issued under: at request (MANDATE-RECIPIENT-019) or at execute (MANDATE-RECIPIENT-015) */
  POLICY_CHANGED: 53,
  /** A call that the recipient mode does not use */
  WRONG_RECIPIENT_MODE: 54,
  /** The payout ID was already used */
  PAYOUT_ID_EXISTS: 60,
  /** No payout with that ID */
  PAYOUT_NOT_FOUND: 61,
  /** The payout is not in a status this call accepts */
  PAYOUT_WRONG_STATUS: 62,
  /** The payout is at or after its own expiry */
  PAYOUT_LAPSED: 63,
  /** A repeated approval or recovery vote */
  ALREADY_APPROVED: 64,
  /** The agent that requested the payout is no longer an agent */
  AGENT_REMOVED: 65,
  /** The factory does not support the asset */
  ASSET_NOT_SUPPORTED: 70,
  /** Token recovery of the settlement asset */
  WRONG_ASSET: 71,
  /** A token transfer out of the mandate failed */
  TRANSFER_FAILED: 72,
  /** An arithmetic failure the rules make unreachable */
  INTERNAL_INVARIANT: 90,
} as const);

export type MandateErrorName = keyof typeof MANDATE_ERRORS;

/** The spec name of every code. */
export const MANDATE_ERROR_NAMES_BY_CODE: Readonly<Record<number, MandateErrorName>> =
  Object.freeze({
    10: 'UNAUTHORIZED',
    11: 'ROLE_CONFLICT',
    12: 'ROLE_SET_FULL',
    20: 'MANDATE_REVOKED',
    21: 'MANDATE_EXPIRED',
    22: 'MANDATE_PAUSED',
    23: 'ALREADY_PAUSED',
    24: 'NOT_PAUSED',
    25: 'MANDATE_ACTIVE',
    26: 'PRINCIPAL_CHANGE_PENDING',
    27: 'SWEEP_GRACE_PERIOD',
    30: 'AMOUNT_INVALID',
    31: 'LEGS_INVALID',
    32: 'LEGS_SUM_MISMATCH',
    33: 'BATCH_INVALID',
    34: 'CONFIG_INVALID',
    35: 'REQUEST_DEADLINE_PASSED',
    40: 'BUDGET_EXCEEDED',
    41: 'PAYMENT_CAP_EXCEEDED',
    42: 'DAILY_CAP_EXCEEDED',
    43: 'INSUFFICIENT_FUNDS',
    44: 'BUDGET_BELOW_RESERVED',
    45: 'NOTHING_TO_SWEEP',
    46: 'FEE_EXCEEDS_CAP',
    50: 'RECIPIENT_NOT_ALLOWED',
    51: 'ATTESTATION_INVALID',
    52: 'ATTESTATION_EXPIRED',
    53: 'POLICY_CHANGED',
    54: 'WRONG_RECIPIENT_MODE',
    60: 'PAYOUT_ID_EXISTS',
    61: 'PAYOUT_NOT_FOUND',
    62: 'PAYOUT_WRONG_STATUS',
    63: 'PAYOUT_LAPSED',
    64: 'ALREADY_APPROVED',
    65: 'AGENT_REMOVED',
    70: 'ASSET_NOT_SUPPORTED',
    71: 'WRONG_ASSET',
    72: 'TRANSFER_FAILED',
    90: 'INTERNAL_INVARIANT',
  });
