// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The agent signer service: the keys UJIRA holds for principals who opt in.

import { runSignerService } from '../boot.js';

await runSignerService('agent');
