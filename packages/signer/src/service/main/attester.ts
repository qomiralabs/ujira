// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The attester signer service: the key that vouches for recipients.

import { runSignerService } from '../boot.js';

await runSignerService('attester');
