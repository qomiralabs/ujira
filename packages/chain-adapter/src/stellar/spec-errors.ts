// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The mandate's error codes and their names, kept equal to the vendored
// spec/errors.json by a test. The table lives in code because the build only
// ships src, and a refusal must carry the spec name, never a guess.

export const SPEC_ERRORS: ReadonlyMap<number, string> = new Map([
  [10, 'UNAUTHORIZED'],
  [11, 'ROLE_CONFLICT'],
  [12, 'ROLE_SET_FULL'],
  [20, 'MANDATE_REVOKED'],
  [21, 'MANDATE_EXPIRED'],
  [22, 'MANDATE_PAUSED'],
  [23, 'ALREADY_PAUSED'],
  [24, 'NOT_PAUSED'],
  [25, 'MANDATE_ACTIVE'],
  [26, 'PRINCIPAL_CHANGE_PENDING'],
  [27, 'SWEEP_GRACE_PERIOD'],
  [30, 'AMOUNT_INVALID'],
  [31, 'LEGS_INVALID'],
  [32, 'LEGS_SUM_MISMATCH'],
  [33, 'BATCH_INVALID'],
  [34, 'CONFIG_INVALID'],
  [35, 'REQUEST_DEADLINE_PASSED'],
  [40, 'BUDGET_EXCEEDED'],
  [41, 'PAYMENT_CAP_EXCEEDED'],
  [42, 'DAILY_CAP_EXCEEDED'],
  [43, 'INSUFFICIENT_FUNDS'],
  [44, 'BUDGET_BELOW_RESERVED'],
  [45, 'NOTHING_TO_SWEEP'],
  [46, 'FEE_EXCEEDS_CAP'],
  [50, 'RECIPIENT_NOT_ALLOWED'],
  [51, 'ATTESTATION_INVALID'],
  [52, 'ATTESTATION_EXPIRED'],
  [53, 'POLICY_CHANGED'],
  [54, 'WRONG_RECIPIENT_MODE'],
  [60, 'PAYOUT_ID_EXISTS'],
  [61, 'PAYOUT_NOT_FOUND'],
  [62, 'PAYOUT_WRONG_STATUS'],
  [63, 'PAYOUT_LAPSED'],
  [64, 'ALREADY_APPROVED'],
  [65, 'AGENT_REMOVED'],
  [70, 'ASSET_NOT_SUPPORTED'],
  [71, 'WRONG_ASSET'],
  [72, 'TRANSFER_FAILED'],
  [90, 'INTERNAL_INVARIANT'],
]);

export const TRANSFER_FAILED_CODE = 72;
