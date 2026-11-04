// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Production keys live in AWS KMS, generated there and never exported. This
// backend runs the same policy as every other before any KMS call, sends the
// raw message (a 32 byte transaction hash or a 47 byte attestation message),
// and checks what comes back against the key's public key, so no vendor
// encoding or vendor error crosses the port. Ed25519 only.

import { ed25519 } from '@noble/curves/ed25519.js';
import { SignerDeniedError, SignerUnavailableError } from '@ujira/chain-adapter';
import type {
  AttestationFields,
  AttesterSigner,
  CallOptions,
  ChainAddress,
  NetworkId,
  SignPayload,
  SignatureResult,
  SignerHealth,
  SignerProvider,
  SignerRef,
  UnixSeconds,
} from '@ujira/chain-adapter';
import { encodeAccountAddress } from '@ujira/chain-adapter/codecs';

import { LatencyWindow } from '../latency.js';
import { messageFor } from '../policy.js';
import { parseAttestationFields, parsePayload, parseRef } from '../schemas.js';

import { checkPayable } from '../unpayable.js';
import type { MandateSettlementIndex } from '../unpayable.js';

import type { KmsClient } from './client.js';
import { portError, reasonOf } from './errors.js';

/** The only key spec this backend signs with. */
export const ED25519_SPEC = 'ECC_NIST_EDWARDS25519';
/** The provider name configuration gives keys this backend serves. */
export const AWS_KMS_PROVIDER = 'aws_kms';

// The fixed DER header of an Ed25519 SubjectPublicKeyInfo, before the 32 key bytes.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
// How long a failure colours health once it stops happening.
const REASON_TTL_MS = 60_000;
const DOWN_REASONS: ReadonlySet<string> = new Set([
  'KEY_DISABLED',
  'ACCESS_DENIED',
  'KEY_NOT_FOUND',
]);

/** The KMS key id serving a ref, or null when it has none. */
export type KmsKeyResolver = (ref: SignerRef, opts: CallOptions) => Promise<string | null>;

export interface AwsKmsSignerOptions {
  readonly client: KmsClient;
  readonly keyFor: KmsKeyResolver;
  /** The deadline for one KMS call, on top of the caller's own signal. */
  readonly timeoutMs: number;
  /** Milliseconds since the epoch, for latency and health. */
  readonly now?: () => number;
}

/** The public key inside a DER SubjectPublicKeyInfo, or null when it is not an Ed25519 one. */
export function ed25519KeyOfSpki(spki: Uint8Array): Uint8Array | null {
  const prefix = spki.subarray(0, SPKI_PREFIX.length);
  if (spki.length !== SPKI_PREFIX.length + 32 || !SPKI_PREFIX.equals(prefix)) return null;
  return Uint8Array.from(spki.subarray(SPKI_PREFIX.length));
}

/** The KMS calls and the health both signer classes share. */
class KmsKeys {
  readonly #client: KmsClient;
  readonly #keyFor: KmsKeyResolver;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #latency = new LatencyWindow();
  // A public key never changes for a key id, and reading one is a billed call.
  readonly #publicKeys = new Map<string, Uint8Array>();
  #reason: { readonly code: string; readonly at: number } | null = null;

  constructor(options: AwsKmsSignerOptions) {
    this.#client = options.client;
    this.#keyFor = options.keyFor;
    this.#timeoutMs = options.timeoutMs;
    this.#now = options.now ?? Date.now;
  }

  #signal(opts: CallOptions): AbortSignal {
    const signals = [AbortSignal.timeout(this.#timeoutMs)];
    if (opts.signal !== undefined) signals.push(opts.signal);
    return AbortSignal.any(signals);
  }

  /** Runs one KMS call, turning any failure into the port's error. */
  async #call<T>(network: NetworkId, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const code = reasonOf(error);
      if (code !== null) this.#reason = { code, at: this.#now() };
      throw portError(error, network);
    }
  }

  async #keyId(ref: SignerRef, opts: CallOptions): Promise<string> {
    // Before any KMS call: an external ref has no key to use.
    if (ref.kind === 'external') throw new SignerDeniedError({ network: ref.network });
    const keyId = await this.#keyFor(ref, opts);
    if (keyId === null) throw new SignerDeniedError({ network: ref.network });
    return keyId;
  }

  async #publicKeyOf(keyId: string, network: NetworkId, opts: CallOptions): Promise<Uint8Array> {
    const cached = this.#publicKeys.get(keyId);
    if (cached !== undefined) return cached;
    const info = await this.#call(network, () =>
      this.#client.getPublicKey(keyId, { signal: this.#signal(opts) }),
    );
    const key = info.keySpec === ED25519_SPEC ? ed25519KeyOfSpki(info.spki) : null;
    if (key === null) throw new SignerDeniedError({ network });
    this.#publicKeys.set(keyId, key);
    return key;
  }

  async publicKey(ref: SignerRef, opts: CallOptions): Promise<Uint8Array> {
    return this.#publicKeyOf(await this.#keyId(ref, opts), ref.network, opts);
  }

  async sign(ref: SignerRef, payload: SignPayload, opts: CallOptions): Promise<SignatureResult> {
    const keyId = await this.#keyId(ref, opts);
    const publicKey = await this.#publicKeyOf(keyId, ref.network, opts);
    const message = messageFor(ref, payload, encodeAccountAddress(publicKey));
    const started = this.#now();
    const { signature, requestId } = await this.#call(ref.network, () =>
      this.#client.sign(keyId, message, { signal: this.#signal(opts) }),
    );
    // Checked before it leaves, as the port promises every caller.
    if (signature.length !== 64 || !ed25519.verify(signature, message, publicKey)) {
      throw new SignerUnavailableError({ network: ref.network });
    }
    this.#latency.record(this.#now() - started);
    this.#reason = null;
    return {
      kind: 'ed25519',
      signature: Uint8Array.from(signature),
      publicKey,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  health(): SignerHealth {
    const now = this.#now();
    const reason =
      this.#reason !== null && now - this.#reason.at < REASON_TTL_MS ? this.#reason : null;
    const state = reason === null ? 'healthy' : DOWN_REASONS.has(reason.code) ? 'down' : 'degraded';
    return {
      state,
      checkedAt: BigInt(Math.floor(now / 1000)) as UnixSeconds,
      signP95Ms: this.#latency.p95(),
      reasons: reason === null ? [] : [reason.code],
    };
  }
}

function checkOpen(opts: CallOptions): void {
  // A caller that has given up must not cost a KMS call.
  if (opts.signal?.aborted === true) throw new SignerUnavailableError();
}

export class AwsKmsSigner implements SignerProvider {
  readonly #keys: KmsKeys;

  constructor(options: AwsKmsSignerOptions) {
    this.#keys = new KmsKeys(options);
  }

  async sign(ref: SignerRef, payload: SignPayload, opts: CallOptions): Promise<SignatureResult> {
    checkOpen(opts);
    return this.#keys.sign(parseRef(ref), parsePayload(payload), opts);
  }

  async address(ref: SignerRef, opts: CallOptions): Promise<ChainAddress> {
    checkOpen(opts);
    const parsed = parseRef(ref);
    return {
      network: parsed.network,
      value: encodeAccountAddress(await this.#keys.publicKey(parsed, opts)),
    };
  }

  health(opts: CallOptions): Promise<SignerHealth> {
    return Promise.resolve().then(() => {
      checkOpen(opts);
      return this.#keys.health();
    });
  }
}

export interface AwsKmsAttesterSignerOptions extends AwsKmsSignerOptions {
  /** Where the attester reads what each mandate settles through. */
  readonly mandates: MandateSettlementIndex;
}

export class AwsKmsAttesterSigner implements AttesterSigner {
  readonly #keys: KmsKeys;
  readonly #mandates: MandateSettlementIndex;

  constructor(options: AwsKmsAttesterSignerOptions) {
    this.#keys = new KmsKeys(options);
    this.#mandates = options.mandates;
  }

  async signAttestation(fields: AttestationFields, opts: CallOptions): Promise<SignatureResult> {
    checkOpen(opts);
    const parsed = parseAttestationFields(fields);
    await checkPayable(parsed, this.#mandates, opts);
    const network = parsed.mandate.network;
    return this.#keys.sign(
      { kind: 'attester', network },
      { kind: 'attestation', network, fields: parsed },
      opts,
    );
  }

  async publicKey(network: NetworkId, opts: CallOptions): Promise<Uint8Array> {
    checkOpen(opts);
    return this.#keys.publicKey(parseRef({ kind: 'attester', network }), opts);
  }
}
