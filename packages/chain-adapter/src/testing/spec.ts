// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mandate spec's constants and error table, as the fake chain uses them.
// A test compares both with the vendored spec files, so a spec change that
// lands without an engine change fails instead of drifting quietly.

export const SPEC_VERSION = 1;

export const I128_MAX = (1n << 127n) - 1n;
export const I128_MIN = -(1n << 127n);
export const U64_MAX = (1n << 64n) - 1n;
export const U32_MAX = 4_294_967_295;

export const SECONDS_PER_DAY = 86_400n;
export const MAX_LEGS = 4;
export const MAX_BATCH = 10;
export const MAX_BATCH_TRANSFERS = 18;
export const MAX_AGENTS = 8;
export const MAX_APPROVERS = 10;
export const MAX_GUARDIANS = 4;
export const MAX_EXECUTORS = 4;
export const MAX_RECOVERY = 10;
export const MAX_ATTESTATION_VALIDITY = 86_400n;
export const ATTESTER_KEY_BYTES = 32;
export const ATTESTATION_SIGNATURE_BYTES = 64;
export const ATTESTATION_MESSAGE_BYTES = 47;
export const MAX_FEE_BPS = 100;
export const BPS_DENOMINATOR = 10_000n;
export const PAYOUT_TTL_MIN = 3_600n;
export const PAYOUT_TTL_MAX = 2_592_000n;
export const SWEEP_GRACE_SECONDS = 2_592_000n;
export const RECORD_TTL_MARGIN_SECONDS = 86_400n;
export const STELLAR_LEDGER_SECONDS = 5;

/** Every constant by its spec name, in the form constants.json writes it. */
export const SPEC_CONSTANTS: Readonly<Record<string, number | string>> = Object.freeze({
  SPEC_VERSION,
  I128_MAX: I128_MAX.toString(),
  SECONDS_PER_DAY: Number(SECONDS_PER_DAY),
  MAX_LEGS,
  MAX_BATCH,
  MAX_BATCH_TRANSFERS,
  MAX_AGENTS,
  MAX_APPROVERS,
  MAX_GUARDIANS,
  MAX_EXECUTORS,
  MAX_RECOVERY,
  MAX_ATTESTATION_VALIDITY: Number(MAX_ATTESTATION_VALIDITY),
  ATTESTER_KEY_BYTES,
  ATTESTATION_SIGNATURE_BYTES,
  ATTESTATION_MESSAGE_BYTES,
  MAX_FEE_BPS,
  BPS_DENOMINATOR: Number(BPS_DENOMINATOR),
  PAYOUT_TTL_MIN: Number(PAYOUT_TTL_MIN),
  PAYOUT_TTL_MAX: Number(PAYOUT_TTL_MAX),
  SWEEP_GRACE_SECONDS: Number(SWEEP_GRACE_SECONDS),
  RECORD_TTL_MARGIN_SECONDS: Number(RECORD_TTL_MARGIN_SECONDS),
  STELLAR_LEDGER_SECONDS,
});

export const ROLE = Object.freeze({
  AGENT: 1,
  APPROVER: 2,
  GUARDIAN: 3,
  EXECUTOR: 4,
  RECOVERY: 5,
} as const);

export type RoleCode = (typeof ROLE)[keyof typeof ROLE];

export const RECOVERY_ACTION = Object.freeze({ REVOKE: 1, ROTATE_AGENT: 2 } as const);

export type RecoveryActionKind = (typeof RECOVERY_ACTION)[keyof typeof RECOVERY_ACTION];

/** The error table, append only: codes are never reused. */
export const MANDATE_ERRORS = Object.freeze({
  UNAUTHORIZED: 10,
  ROLE_CONFLICT: 11,
  ROLE_SET_FULL: 12,
  MANDATE_REVOKED: 20,
  MANDATE_EXPIRED: 21,
  MANDATE_PAUSED: 22,
  ALREADY_PAUSED: 23,
  NOT_PAUSED: 24,
  MANDATE_ACTIVE: 25,
  PRINCIPAL_CHANGE_PENDING: 26,
  SWEEP_GRACE_PERIOD: 27,
  AMOUNT_INVALID: 30,
  LEGS_INVALID: 31,
  LEGS_SUM_MISMATCH: 32,
  BATCH_INVALID: 33,
  CONFIG_INVALID: 34,
  REQUEST_DEADLINE_PASSED: 35,
  BUDGET_EXCEEDED: 40,
  PAYMENT_CAP_EXCEEDED: 41,
  DAILY_CAP_EXCEEDED: 42,
  INSUFFICIENT_FUNDS: 43,
  BUDGET_BELOW_RESERVED: 44,
  NOTHING_TO_SWEEP: 45,
  FEE_EXCEEDS_CAP: 46,
  RECIPIENT_NOT_ALLOWED: 50,
  ATTESTATION_INVALID: 51,
  ATTESTATION_EXPIRED: 52,
  POLICY_CHANGED: 53,
  WRONG_RECIPIENT_MODE: 54,
  PAYOUT_ID_EXISTS: 60,
  PAYOUT_NOT_FOUND: 61,
  PAYOUT_WRONG_STATUS: 62,
  PAYOUT_LAPSED: 63,
  ALREADY_APPROVED: 64,
  AGENT_REMOVED: 65,
  ASSET_NOT_SUPPORTED: 70,
  WRONG_ASSET: 71,
  TRANSFER_FAILED: 72,
  INTERNAL_INVARIANT: 90,
} as const);

export type MandateErrorName = keyof typeof MANDATE_ERRORS;

const ERROR_NAMES: ReadonlyMap<number, MandateErrorName> = new Map(
  (Object.entries(MANDATE_ERRORS) as [MandateErrorName, number][]).map(([name, code]) => [
    code,
    name,
  ]),
);

/** The error name of a code, or undefined for a code the table does not hold. */
export function mandateErrorName(code: number): MandateErrorName | undefined {
  return ERROR_NAMES.get(code);
}

export function isMandateErrorName(name: string): name is MandateErrorName {
  return Object.hasOwn(MANDATE_ERRORS, name);
}

export const PAYOUT_STATUSES = Object.freeze([
  'PENDING',
  'APPROVED',
  'EXECUTED',
  'REJECTED',
  'CANCELLED',
] as const);

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export type OpenStatus = Extract<PayoutStatus, 'PENDING' | 'APPROVED'>;
export type TerminalStatus = Exclude<PayoutStatus, OpenStatus>;

export const RECIPIENT_MODES = Object.freeze(['ALLOWLIST', 'ATTESTED', 'BOTH'] as const);

export type RecipientMode = (typeof RECIPIENT_MODES)[number];

/** Cancel reasons, in the order the spec tests them. */
export const CANCEL_REASON = Object.freeze({ PRINCIPAL: 1, AGENT: 2, LAPSED: 3 } as const);

export type CancelReason = (typeof CANCEL_REASON)[keyof typeof CANCEL_REASON];
