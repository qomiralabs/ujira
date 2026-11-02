// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// @ujira/signer/aws-kms: the production backends. A subpath of its own, so a
// caller that only needs RemoteSigner never loads the vendor SDK.

export { KmsCallError } from './client.js';
export type {
  KmsCallOptions,
  KmsCiphertext,
  KmsClient,
  KmsEncryptionContext,
  KmsPublicKey,
  KmsSignature,
} from './client.js';
export { DEFAULT_KMS_REGION, KMS_REGION_VARIABLE, readKmsEnvironment } from './config.js';
export type { KmsEnvironment } from './config.js';
export { AwsKmsKeyManager, KEY_MANAGER_IAM_ACTIONS, PII_KEK_VARIABLE } from './key-manager.js';
export type {
  AwsKmsKeyManagerOptions,
  KeyManager,
  WrapContext,
  WrappedKey,
} from './key-manager.js';
export { configKeyResolver } from './keys.js';
export type { ExtraKmsKey } from './keys.js';
export { awsKmsClient } from './sdk-client.js';
export type { AwsKmsClientOptions, KmsSend } from './sdk-client.js';
export {
  AWS_KMS_PROVIDER,
  AwsKmsAttesterSigner,
  AwsKmsSigner,
  ED25519_SPEC,
  ed25519KeyOfSpki,
} from './signer.js';
export type { AwsKmsSignerOptions, KmsKeyResolver } from './signer.js';
