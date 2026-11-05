// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The chain signer service: executors, the fee sponsor and SEP-10 keys.

import { runSignerService } from '../boot.js';

await runSignerService('chain');
