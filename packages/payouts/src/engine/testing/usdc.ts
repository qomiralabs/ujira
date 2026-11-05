// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { tokenAmount, type TokenAmount } from '@ujira/core';

export const usdc = (raw: bigint): TokenAmount => tokenAmount(raw, 'USDC', 'stellar');
