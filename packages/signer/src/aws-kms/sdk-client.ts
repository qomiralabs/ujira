// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The one file that knows the AWS SDK. Credentials come from the SDK's
// default chain, which readKmsEnvironment has already narrowed to the
// platform's web identity token. Errors keep only the vendor's error name
// and request id, because a vendor message can quote a key id or an ARN.

import {
  DecryptCommand,
  EncryptCommand,
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
} from '@aws-sdk/client-kms';

import { KmsCallError } from './client.js';
import type { KmsClient } from './client.js';
import type { KmsEnvironment } from './config.js';

// Signs the message itself rather than a digest, as Stellar and the mandate
// verify it.
const SIGNING_ALGORITHM = 'ED25519_SHA_512';
const MESSAGE_TYPE = 'RAW';

/** One SDK call; the SDK's own client in production and a stand in under test. */
export type KmsSend = (command: unknown, options: { abortSignal: AbortSignal }) => Promise<unknown>;

function callError(error: unknown): KmsCallError {
  const details = error as { name?: unknown; $metadata?: { requestId?: unknown } } | null;
  const name = typeof details?.name === 'string' ? details.name : 'Unknown';
  const requestId = details?.$metadata?.requestId;
  return new KmsCallError(name, typeof requestId === 'string' ? requestId : undefined);
}

function requireBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new KmsCallError('MalformedResponse');
  return value;
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') throw new KmsCallError('MalformedResponse');
  return value;
}

export interface AwsKmsClientOptions {
  readonly environment: KmsEnvironment;
  /** For tests; the SDK's client when left out. */
  readonly send?: KmsSend;
}

export function awsKmsClient(options: AwsKmsClientOptions): KmsClient {
  let send = options.send;
  if (send === undefined) {
    const sdk = new KMSClient({ region: options.environment.region });
    send = (command, sendOptions) => sdk.send(command as never, sendOptions);
  }
  const run = send;
  const call = async (command: unknown, signal: AbortSignal) => {
    try {
      return (await run(command, { abortSignal: signal })) as Record<string, unknown>;
    } catch (error) {
      throw callError(error);
    }
  };
  return {
    async getPublicKey(keyId, { signal }) {
      const reply = await call(new GetPublicKeyCommand({ KeyId: keyId }), signal);
      return { keySpec: requireText(reply['KeySpec']), spki: requireBytes(reply['PublicKey']) };
    },
    async sign(keyId, message, { signal }) {
      const reply = await call(
        new SignCommand({
          KeyId: keyId,
          Message: message,
          MessageType: MESSAGE_TYPE,
          SigningAlgorithm: SIGNING_ALGORITHM,
        }),
        signal,
      );
      const metadata = reply['$metadata'] as { requestId?: string } | undefined;
      return { signature: requireBytes(reply['Signature']), requestId: metadata?.requestId };
    },
    async encrypt(keyId, plaintext, context, { signal }) {
      const reply = await call(
        new EncryptCommand({
          KeyId: keyId,
          Plaintext: plaintext,
          EncryptionContext: { ...context },
        }),
        signal,
      );
      return {
        ciphertext: requireBytes(reply['CiphertextBlob']),
        keyId: requireText(reply['KeyId']),
      };
    },
    async decrypt(keyId, ciphertext, context, { signal }) {
      const reply = await call(
        new DecryptCommand({
          KeyId: keyId,
          CiphertextBlob: ciphertext,
          EncryptionContext: { ...context },
        }),
        signal,
      );
      return requireBytes(reply['Plaintext']);
    },
  };
}
