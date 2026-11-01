// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The signer for development, tests and CI: every key derived from one seed
// held in process memory. That is fine for keys that guard nothing and wrong
// for any key that does, so it refuses to start in production, and startup
// refuses any production key configured with the local provider.

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

import { LOCAL_SEED_VARIABLE, deriveKey, keyLabel, parseLocalSeed } from './keys.js';
import type { LocalKey } from './keys.js';
import { LatencyWindow } from './latency.js';
import { messageFor } from './policy.js';
import { parseAttestationFields, parsePayload, parseRef } from './schemas.js';

export interface LocalSignerOptions {
  /** 64 lower case hex characters; never logged or kept in an error. */
  readonly seed: string;
  /** The deployment environment; process.env.NODE_ENV when left out. */
  readonly nodeEnv?: string | undefined;
  /** Milliseconds since the epoch, for latency and health. */
  readonly now?: () => number;
}

/** Throws when the environment is production, so a local key never guards real funds. */
export function refuseProduction(nodeEnv: string | undefined): void {
  if (nodeEnv === 'production') throw new SignerDeniedError();
}

function checkOpen(opts: CallOptions): void {
  // A caller that has given up must not get a signature it will never use.
  if (opts.signal?.aborted === true) throw new SignerUnavailableError();
}

/** The keys and the signing step both local classes share. */
class LocalKeys {
  readonly #seed: Uint8Array;
  readonly #now: () => number;
  readonly #latency = new LatencyWindow();

  constructor(options: LocalSignerOptions) {
    refuseProduction(options.nodeEnv ?? process.env['NODE_ENV']);
    this.#seed = parseLocalSeed(options.seed);
    this.#now = options.now ?? Date.now;
  }

  key(ref: SignerRef): LocalKey {
    return deriveKey(this.#seed, keyLabel(ref));
  }

  account(ref: SignerRef): string {
    return encodeAccountAddress(this.key(ref).publicKey);
  }

  sign(ref: SignerRef, payload: SignPayload): SignatureResult {
    const started = this.#now();
    const key = this.key(ref);
    const message = messageFor(ref, payload, encodeAccountAddress(key.publicKey));
    const signature = ed25519.sign(message, key.secretKey);
    // Checked before it leaves, as the port promises every caller.
    if (!ed25519.verify(signature, message, key.publicKey)) {
      throw new SignerUnavailableError({ network: ref.network });
    }
    this.#latency.record(this.#now() - started);
    return { kind: 'ed25519', signature, publicKey: key.publicKey };
  }

  health(): SignerHealth {
    return {
      state: 'healthy',
      checkedAt: BigInt(Math.floor(this.#now() / 1000)) as UnixSeconds,
      signP95Ms: this.#latency.p95(),
      reasons: [],
    };
  }
}

export class LocalSigner implements SignerProvider {
  readonly #keys: LocalKeys;

  constructor(options: LocalSignerOptions) {
    this.#keys = new LocalKeys(options);
  }

  /** A signer seeded from UJIRA_SIGNER_LOCAL_SEED. */
  static fromEnv(env: Readonly<Record<string, string | undefined>> = process.env): LocalSigner {
    return new LocalSigner({ seed: env[LOCAL_SEED_VARIABLE] ?? '', nodeEnv: env['NODE_ENV'] });
  }

  sign(ref: SignerRef, payload: SignPayload, opts: CallOptions): Promise<SignatureResult> {
    return Promise.resolve().then(() => {
      checkOpen(opts);
      return this.#keys.sign(parseRef(ref), parsePayload(payload));
    });
  }

  address(ref: SignerRef, opts: CallOptions): Promise<ChainAddress> {
    return Promise.resolve().then(() => {
      checkOpen(opts);
      const parsed = parseRef(ref);
      return { network: parsed.network, value: this.#keys.account(parsed) };
    });
  }

  health(opts: CallOptions): Promise<SignerHealth> {
    return Promise.resolve().then(() => {
      checkOpen(opts);
      return this.#keys.health();
    });
  }
}

export class LocalAttesterSigner implements AttesterSigner {
  readonly #keys: LocalKeys;

  constructor(options: LocalSignerOptions) {
    this.#keys = new LocalKeys(options);
  }

  /** An attester seeded from UJIRA_SIGNER_LOCAL_SEED. */
  static fromEnv(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): LocalAttesterSigner {
    return new LocalAttesterSigner({
      seed: env[LOCAL_SEED_VARIABLE] ?? '',
      nodeEnv: env['NODE_ENV'],
    });
  }

  signAttestation(fields: AttestationFields, opts: CallOptions): Promise<SignatureResult> {
    return Promise.resolve().then(() => {
      checkOpen(opts);
      const parsed = parseAttestationFields(fields);
      const network = parsed.mandate.network;
      return this.#keys.sign(
        { kind: 'attester', network },
        { kind: 'attestation', network, fields: parsed },
      );
    });
  }

  publicKey(network: NetworkId, opts: CallOptions): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      checkOpen(opts);
      return this.#keys.key(parseRef({ kind: 'attester', network })).publicKey;
    });
  }
}
