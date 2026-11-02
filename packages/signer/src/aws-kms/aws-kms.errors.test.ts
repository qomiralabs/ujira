// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Throttling, internal errors, timeouts and anything unknown are
// SIGNER_UNAVAILABLE, which is retried; a disabled or deleted key and refused
// access are SIGNER_DENIED, which needs a person. Nothing of the vendor's
// reaches the caller. The client is a fake.

import { SignerDeniedError, SignerUnavailableError } from '@ujira/chain-adapter';
import type { CallOptions, SignerRef } from '@ujira/chain-adapter';
import { testTransactionXdr } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { keyLabel } from '../keys.js';
import { FakeKmsClient } from '../testing/fake-kms.js';
import { KmsCallError } from './client.js';
import { portError, reasonOf } from './errors.js';
import { AwsKmsSigner } from './index.js';

const OPTS: CallOptions = { correlationId: 'aws-kms-errors-test' };
const NETWORK = 'stellar:testnet';
const EXECUTOR: SignerRef = { kind: 'executor', network: NETWORK, keyId: 'executor_0' };

describe('the error map', () => {
  it.each([
    ['ThrottlingException', SignerUnavailableError],
    ['LimitExceededException', SignerUnavailableError],
    ['KMSInternalException', SignerUnavailableError],
    ['DependencyTimeoutException', SignerUnavailableError],
    ['TimeoutError', SignerUnavailableError],
    ['AbortError', SignerUnavailableError],
    ['SomethingNew', SignerUnavailableError],
    ['DisabledException', SignerDeniedError],
    ['KMSInvalidStateException', SignerDeniedError],
    ['AccessDeniedException', SignerDeniedError],
    ['NotFoundException', SignerDeniedError],
    ['InvalidKeyUsageException', SignerDeniedError],
    ['IncorrectKeyException', SignerDeniedError],
    ['InvalidGrantTokenException', SignerDeniedError],
    ['KeyUnavailableException', SignerDeniedError],
  ])('%s', async (errorName, expected) => {
    expect(portError(new KmsCallError(errorName), NETWORK)).toBeInstanceOf(expected);
    const client = new FakeKmsClient();
    const signer = new AwsKmsSigner({
      client,
      keyFor: (ref) => Promise.resolve(keyLabel(ref)),
      timeoutMs: 5_000,
    });
    const source = (await signer.address(EXECUTOR, OPTS)).value;
    client.failNext(errorName, 'sign');
    const failure: unknown = await signer
      .sign(
        EXECUTOR,
        { kind: 'stellar_tx', network: NETWORK, xdr: testTransactionXdr({ source }) },
        OPTS,
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(expected);
    expect(JSON.stringify(failure)).not.toContain(errorName);
  });

  it('maps a failure reading the public key the same way', async () => {
    const client = new FakeKmsClient();
    const signer = new AwsKmsSigner({
      client,
      keyFor: (ref) => Promise.resolve(keyLabel(ref)),
      timeoutMs: 5_000,
    });
    client.failNext('AccessDeniedException', 'getPublicKey');
    await expect(signer.address(EXECUTOR, OPTS)).rejects.toBeInstanceOf(SignerDeniedError);
    client.failNext('ThrottlingException', 'getPublicKey');
    await expect(signer.address(EXECUTOR, OPTS)).rejects.toBeInstanceOf(SignerUnavailableError);
  });

  it('treats anything that is not a KMS failure as an outage, with no reason', () => {
    expect(portError(new TypeError('socket'))).toBeInstanceOf(SignerUnavailableError);
    expect(reasonOf(new TypeError('socket'))).toBeNull();
  });
});
