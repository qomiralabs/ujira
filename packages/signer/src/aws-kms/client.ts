// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The part of AWS KMS the signer backends use, as plain data, so the vendor
// SDK and its encodings stop at one small file and everything else is tested
// against a fake with no account, no credentials and no network.

/** A failure the key manager reported, by its error name. */
export class KmsCallError extends Error {
  override readonly name = 'KmsCallError';
  /** The vendor's error name, such as ThrottlingException. Never its message. */
  readonly errorName: string;
  /** The vendor's request id, when it gave one. */
  readonly requestId: string | undefined;

  constructor(errorName: string, requestId?: string) {
    super(errorName);
    this.errorName = errorName;
    this.requestId = requestId;
  }
}

export interface KmsCallOptions {
  /** Aborts at the caller's deadline. */
  readonly signal: AbortSignal;
}

export interface KmsPublicKey {
  /** The key's spec; only ECC_NIST_EDWARDS25519 is ever signed with. */
  readonly keySpec: string;
  /** DER encoded SubjectPublicKeyInfo, as the service returns it. */
  readonly spki: Uint8Array;
}

export interface KmsSignature {
  /** 64 raw bytes for an Ed25519 key. */
  readonly signature: Uint8Array;
  readonly requestId: string | undefined;
}

export interface KmsCiphertext {
  readonly ciphertext: Uint8Array;
  /** The key that encrypted it, which decrypting must name again. */
  readonly keyId: string;
}

/** Name and value pairs bound to a ciphertext; they appear in the audit log in clear. */
export type KmsEncryptionContext = Readonly<Record<string, string>>;

/** Throws KmsCallError for anything the service refuses or cannot do. */
export interface KmsClient {
  getPublicKey(keyId: string, options: KmsCallOptions): Promise<KmsPublicKey>;
  /** Signs the raw message: never a digest of it, and no vendor framing. */
  sign(keyId: string, message: Uint8Array, options: KmsCallOptions): Promise<KmsSignature>;
  encrypt(
    keyId: string,
    plaintext: Uint8Array,
    context: KmsEncryptionContext,
    options: KmsCallOptions,
  ): Promise<KmsCiphertext>;
  decrypt(
    keyId: string,
    ciphertext: Uint8Array,
    context: KmsEncryptionContext,
    options: KmsCallOptions,
  ): Promise<Uint8Array>;
}
