// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The local signer against the suite every backend must pass.

import { LocalAttesterSigner, LocalSigner } from './index.js';
import { describeSignerProvider } from './testing/conformance.js';

// A fixed test seed, built rather than written out so it never reads as a key.
const seed = '3c'.repeat(32);

describeSignerProvider('LocalSigner', () => ({
  provider: new LocalSigner({ seed, nodeEnv: 'test' }),
  attester: new LocalAttesterSigner({ seed, nodeEnv: 'test' }),
}));
