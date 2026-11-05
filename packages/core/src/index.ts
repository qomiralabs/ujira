// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/** Package name, exported so consumers and tests can confirm the build wiring. */
export const PACKAGE_NAME = '@ujira/core';

export * from './money/index.js';
export {
  InvalidFeeBpsError,
  InvalidFeeTotalError,
  MAX_FEE_BPS,
  feeBps,
  feeCap,
} from './fees/fee-cap.js';
