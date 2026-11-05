// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The flows here are typed against ports so they did not have to wait for
// the adapter. This keeps those ports honest: a registry's adapter has to
// satisfy them as it is, with nothing in between.

import type { ChainAdapter } from '@ujira/chain-adapter';
import { expectTypeOf } from 'vitest';

import type { AttestationChain } from '../ports.js';
import type { WalletProofChain } from './ports.js';

expectTypeOf<ChainAdapter>().toExtend<WalletProofChain>();
expectTypeOf<ChainAdapter>().toExtend<AttestationChain>();
