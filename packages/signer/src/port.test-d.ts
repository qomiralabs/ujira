// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Compile time checks, run by typecheck. What crosses the port is raw
// ed25519 bytes and the key that made them: no DER blob, recovery ID, key
// version or other key manager field can be added to SignatureResult
// without failing here. The local classes implement the ports exactly.

import type {
  AttestationFields,
  AttesterSigner,
  SignatureResult,
  SignerProvider,
} from '@ujira/chain-adapter';
import type { AttestationMessageFields } from '@ujira/chain-adapter/codecs';
import { describe, expectTypeOf, it } from 'vitest';

import type { LocalAttesterSigner, LocalSigner } from './index.js';

describe('the signer port', () => {
  it('SignatureResult carries no DER or vendor fields', () => {
    expectTypeOf<keyof SignatureResult>().toEqualTypeOf<
      'kind' | 'signature' | 'publicKey' | 'requestId'
    >();
    // A log reference, optional, and text: it can carry no signature encoding.
    expectTypeOf<SignatureResult['requestId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SignatureResult['kind']>().toEqualTypeOf<'ed25519'>();
    expectTypeOf<SignatureResult['signature']>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<SignatureResult['publicKey']>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<SignatureResult>().not.toHaveProperty('der');
    expectTypeOf<SignatureResult>().not.toHaveProperty('recoveryId');
    expectTypeOf<SignatureResult>().not.toHaveProperty('keyVersion');
    expectTypeOf<SignatureResult>().not.toHaveProperty('vendor');
  });

  it('the local classes implement the ports', () => {
    expectTypeOf<LocalSigner>().toExtend<SignerProvider>();
    expectTypeOf<LocalAttesterSigner>().toExtend<AttesterSigner>();
  });

  it('the attestation the port carries is what the codecs lay out', () => {
    expectTypeOf<AttestationFields>().toExtend<AttestationMessageFields>();
  });
});
