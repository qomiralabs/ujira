// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/*
 * Contract for the KMS environment and the SDK binding (aws-kms/config.ts,
 * aws-kms/sdk-client.ts).
 *
 * readKmsEnvironment requires the managed OIDC role and token file, refuses
 * any static credential, and takes the region from UJIRA_KMS_REGION,
 * Frankfurt by default. Errors name the variable and never its value.
 * awsKmsClient sends the raw message as Ed25519, keeps only a vendor error's
 * name and request id, and refuses a malformed reply. The SDK's send is a
 * stand in: no credentials, account or network are used.
 */

import { InvalidInputError } from '@ujira/chain-adapter';
import { describe, expect, it } from 'vitest';

import { KmsCallError } from './client.js';
import { DEFAULT_KMS_REGION, readKmsEnvironment } from './config.js';
import { awsKmsClient } from './sdk-client.js';
import { ED25519_SPEC } from './signer.js';
import type { KmsSend } from './sdk-client.js';

const OIDC = { AWS_ROLE_ARN: 'role', AWS_WEB_IDENTITY_TOKEN_FILE: '/token' };
const REGION = { region: DEFAULT_KMS_REGION };
const CALL = { signal: new AbortController().signal };

function issuesOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    readKmsEnvironment(env);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidInputError);
    return (error as InvalidInputError).issues;
  }
  throw new Error('expected a throw');
}

describe('the KMS environment', () => {
  it('refuses to start with AWS_ACCESS_KEY_ID set', () => {
    expect(issuesOf({ ...OIDC, AWS_ACCESS_KEY_ID: 'value-that-must-not-show' })).toEqual([
      'AWS_ACCESS_KEY_ID (forbidden)',
    ]);
  });

  it.each(['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'])(
    'refuses to start with %s set',
    (name) => {
      expect(issuesOf({ ...OIDC, [name]: 'x' })).toEqual([`${name} (forbidden)`]);
    },
  );

  it('requires the managed role and token file', () => {
    expect(issuesOf({ AWS_WEB_IDENTITY_TOKEN_FILE: '/token' })).toEqual(['AWS_ROLE_ARN (missing)']);
    expect(issuesOf({ AWS_ROLE_ARN: 'role' })).toEqual(['AWS_WEB_IDENTITY_TOKEN_FILE (missing)']);
    expect(issuesOf({ ...OIDC, AWS_ROLE_ARN: '' })).toEqual(['AWS_ROLE_ARN (missing)']);
  });

  it('defaults the region to Frankfurt, and checks one given', () => {
    expect(readKmsEnvironment(OIDC)).toEqual({ region: 'eu-central-1' });
    expect(readKmsEnvironment({ ...OIDC, UJIRA_KMS_REGION: 'us-east-1' })).toEqual({
      region: 'us-east-1',
    });
    expect(issuesOf({ ...OIDC, UJIRA_KMS_REGION: 'not a region' })).toEqual([
      'UJIRA_KMS_REGION (invalid)',
    ]);
  });
});

describe('the SDK binding', () => {
  const inputOf = (command: unknown) => (command as { input: Record<string, unknown> }).input;

  it('builds a client with the real SDK and no call', () => {
    expect(awsKmsClient({ environment: REGION })).toBeTypeOf('object');
  });

  it('signs the raw message as Ed25519, with the caller signal', async () => {
    const seen: unknown[] = [];
    const signal = new AbortController().signal;
    const send: KmsSend = (command, options) => {
      seen.push(inputOf(command), options.abortSignal);
      return Promise.resolve({ Signature: new Uint8Array(64), $metadata: { requestId: 'r-1' } });
    };
    const message = Uint8Array.of(1, 2, 3);
    const reply = await awsKmsClient({ environment: REGION, send }).sign('k', message, { signal });
    expect(reply).toEqual({ signature: new Uint8Array(64), requestId: 'r-1' });
    expect(seen).toEqual([
      { KeyId: 'k', Message: message, MessageType: 'RAW', SigningAlgorithm: 'ED25519_SHA_512' },
      signal,
    ]);
  });

  it('reads public keys, and wraps with the encryption context', async () => {
    const context = { principal_id: 'p' };
    const replies: Record<string, unknown> = {
      GetPublicKeyCommand: { KeySpec: ED25519_SPEC, PublicKey: new Uint8Array(44) },
      EncryptCommand: { CiphertextBlob: Uint8Array.of(9), KeyId: 'arn' },
      DecryptCommand: { Plaintext: Uint8Array.of(7) },
    };
    const inputs: Record<string, unknown>[] = [];
    const send: KmsSend = (command) => {
      inputs.push(inputOf(command));
      return Promise.resolve(replies[(command as object).constructor.name]);
    };
    const client = awsKmsClient({ environment: REGION, send });
    expect(await client.getPublicKey('k', CALL)).toEqual({
      keySpec: ED25519_SPEC,
      spki: new Uint8Array(44),
    });
    expect(await client.encrypt('k', Uint8Array.of(1), context, CALL)).toEqual({
      ciphertext: Uint8Array.of(9),
      keyId: 'arn',
    });
    expect(await client.decrypt('k', Uint8Array.of(9), context, CALL)).toEqual(Uint8Array.of(7));
    expect(inputs[1]).toMatchObject({ KeyId: 'k', EncryptionContext: context });
    expect(inputs[2]).toMatchObject({ KeyId: 'k', EncryptionContext: context });
  });

  it('keeps only the name and request id of a vendor error', async () => {
    const vendor = Object.assign(new Error('arn:aws:kms:eu-central-1:1234:key/secret'), {
      name: 'ThrottlingException',
      $metadata: { requestId: 'r-2' },
    });
    const client = awsKmsClient({ environment: REGION, send: () => Promise.reject(vendor) });
    const failure = (await client
      .sign('k', new Uint8Array(1), CALL)
      .catch((e: unknown) => e)) as KmsCallError;
    expect(failure).toBeInstanceOf(KmsCallError);
    expect(failure.errorName).toBe('ThrottlingException');
    expect(failure.requestId).toBe('r-2');
    expect(failure.message).not.toContain('arn:aws');
    const bare = awsKmsClient({
      environment: REGION,
      send: () => Promise.reject(Object.assign(new Error('x'), { name: 5 })),
    });
    await expect(bare.sign('k', new Uint8Array(1), CALL)).rejects.toMatchObject({
      errorName: 'Unknown',
      requestId: undefined,
    });
  });

  it('refuses a malformed reply', async () => {
    const client = awsKmsClient({ environment: REGION, send: () => Promise.resolve({}) });
    await expect(client.sign('k', new Uint8Array(1), CALL)).rejects.toMatchObject({
      errorName: 'MalformedResponse',
    });
    await expect(client.getPublicKey('k', CALL)).rejects.toMatchObject({
      errorName: 'MalformedResponse',
    });
  });
});
