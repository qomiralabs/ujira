// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the AWS KMS signer backend (aws-kms/), against a fake client.
 * No account, credentials or network are involved.
 *
 * AwsKmsSigner passes the conformance suite. It runs the shared policy before
 * any KMS call, signs the raw message, verifies the result before returning
 * it and caches public keys. A key of the wrong kind is SIGNER_DENIED. Health
 * reports state, p95 and a reason, which clears on the next success or after a
 * minute. aws-kms.errors.test.ts covers the error map.
 */

import { SignerDeniedError, SignerUnavailableError } from '@ujira/chain-adapter';
import type { CallOptions, SignerRef } from '@ujira/chain-adapter';
import { testTransactionXdr } from '@ujira/chain-adapter/testing';
import { describe, expect, it } from 'vitest';

import { keyLabel } from '../keys.js';
import { describeSignerProvider } from '../testing/conformance.js';
import { FakeKmsClient } from '../testing/fake-kms.js';
import { reasonOf } from './errors.js';
import { AwsKmsAttesterSigner, AwsKmsSigner, ed25519KeyOfSpki } from './index.js';
import type { AwsKmsSignerOptions } from './index.js';

const OPTS: CallOptions = { correlationId: 'aws-kms-test' };
const NETWORK = 'stellar:testnet';
const EXECUTOR: SignerRef = { kind: 'executor', network: NETWORK, keyId: 'executor_0' };

const options = (client: FakeKmsClient, extra: Partial<AwsKmsSignerOptions> = {}) => ({
  client,
  keyFor: (ref: SignerRef) => Promise.resolve(keyLabel(ref)),
  timeoutMs: 5_000,
  ...extra,
});

describeSignerProvider('AwsKmsSigner against a fake client', () => {
  const client = new FakeKmsClient();
  return {
    provider: new AwsKmsSigner(options(client)),
    attester: new AwsKmsAttesterSigner(options(client)),
  };
});

async function setup(extra: Partial<AwsKmsSignerOptions> = {}) {
  const client = new FakeKmsClient();
  const signer = new AwsKmsSigner(options(client, extra));
  const source = (await signer.address(EXECUTOR, OPTS)).value;
  const payload = {
    kind: 'stellar_tx',
    network: NETWORK,
    xdr: testTransactionXdr({ source }),
  } as const;
  return { client, signer, payload };
}

describe('calling KMS', () => {
  it('reads each public key once', async () => {
    const { client, signer, payload } = await setup();
    await signer.sign(EXECUTOR, payload, OPTS);
    await signer.address(EXECUTOR, OPTS);
    expect(client.calls.filter((c) => c.operation === 'getPublicKey')).toHaveLength(1);
    expect(client.calls.filter((c) => c.operation === 'sign')).toHaveLength(1);
  });

  it('makes no signing call for a payload the policy refuses', async () => {
    const { client, signer } = await setup();
    const foreign = testTransactionXdr({
      source: 'GDTYAUMMX45E2SU2Q7JRJHCXDIYTEUAXVBHZ7DVCVXZGMAKMWFL7SOY4',
    });
    await expect(
      signer.sign(EXECUTOR, { kind: 'stellar_tx', network: NETWORK, xdr: foreign }, OPTS),
    ).rejects.toBeInstanceOf(SignerDeniedError);
    expect(client.calls.filter((c) => c.operation === 'sign')).toEqual([]);
  });

  it('refuses a ref with no key, and an aborted caller, with no KMS call', async () => {
    const client = new FakeKmsClient();
    const signer = new AwsKmsSigner(options(client, { keyFor: () => Promise.resolve(null) }));
    await expect(signer.address(EXECUTOR, OPTS)).rejects.toBeInstanceOf(SignerDeniedError);
    const controller = new AbortController();
    controller.abort();
    const opts = { ...OPTS, signal: controller.signal };
    const open = new AwsKmsSigner(options(client));
    await expect(open.address(EXECUTOR, opts)).rejects.toBeInstanceOf(SignerUnavailableError);
    await expect(open.health(opts)).rejects.toBeInstanceOf(SignerUnavailableError);
    const attester = new AwsKmsAttesterSigner(options(client));
    await expect(attester.publicKey(NETWORK, opts)).rejects.toBeInstanceOf(SignerUnavailableError);
    expect(client.calls).toEqual([]);
  });

  it('refuses a key that is not Ed25519', async () => {
    const client = new FakeKmsClient();
    client.keySpec = 'ECC_SECG_P256K1';
    const signer = new AwsKmsSigner(options(client));
    await expect(signer.address(EXECUTOR, OPTS)).rejects.toBeInstanceOf(SignerDeniedError);
    expect(ed25519KeyOfSpki(new Uint8Array(44))).toBeNull();
    expect(ed25519KeyOfSpki(new Uint8Array(3))).toBeNull();
  });

  it('returns no signature that fails its own verification', async () => {
    const { client, signer, payload } = await setup();
    client.corruptNextSignature();
    await expect(signer.sign(EXECUTOR, payload, OPTS)).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
    await expect(signer.sign(EXECUTOR, payload, OPTS)).resolves.toMatchObject({ kind: 'ed25519' });
  });
});

describe('health', () => {
  it('reports p95 and a reason that clears on success or with time', async () => {
    let clock = 1_700_000_000_000;
    const { client, signer, payload } = await setup({ now: () => (clock += 5) });
    expect(await signer.health(OPTS)).toMatchObject({
      state: 'healthy',
      signP95Ms: null,
      reasons: [],
    });

    client.failNext('ThrottlingException', 'sign');
    await expect(signer.sign(EXECUTOR, payload, OPTS)).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
    expect(await signer.health(OPTS)).toMatchObject({ state: 'degraded', reasons: ['THROTTLED'] });

    await signer.sign(EXECUTOR, payload, OPTS);
    expect(await signer.health(OPTS)).toMatchObject({
      state: 'healthy',
      signP95Ms: 5,
      reasons: [],
    });

    client.failNext('DisabledException', 'sign');
    await expect(signer.sign(EXECUTOR, payload, OPTS)).rejects.toBeInstanceOf(SignerDeniedError);
    expect(await signer.health(OPTS)).toMatchObject({ state: 'down', reasons: ['KEY_DISABLED'] });

    clock += 61_000;
    expect(await signer.health(OPTS)).toMatchObject({ state: 'healthy', reasons: [] });
  });

  it('adds no reason for a failure with no name of its own', async () => {
    const { client, signer, payload } = await setup();
    client.failNext('KMSInternalException', 'sign');
    await expect(signer.sign(EXECUTOR, payload, OPTS)).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
    expect(await signer.health(OPTS)).toMatchObject({ state: 'healthy', reasons: [] });
    expect(reasonOf(new Error('not from KMS'))).toBeNull();
  });
});
