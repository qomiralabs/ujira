// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Contract constants a caller needs to plan around, so it can wait for the moment
// the contract allows rather than send a call it would refuse.

/**
 * How long after expiry anyone but the principal must wait to sweep a mandate that
 * was never revoked. A revoked mandate can be swept at once.
 */
export const SWEEP_GRACE_SECONDS = 2_592_000n;
