// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The client side of a signer service, behind the same port as a local
// backend, so a caller cannot tell which it has. Every call has a deadline.
// A signature is checked here against the bytes this side computes from the
// payload before it is returned, so a service that answered for the wrong
// key or the wrong payload is caught at the caller and never submitted.

import { ed25519 } from '@noble/curves/ed25519.js';
import {
  NETWORK_IDS,
  SignerAddressMismatchError,
  SignerDeniedError,
  SignerUnavailableError,
} from '@ujira/chain-adapter';
import type {
  CallOptions,
  ChainAddress,
  SignPayload,
  SignatureResult,
  SignerHealth,
  SignerProvider,
  SignerRef,
  UnixSeconds,
} from '@ujira/chain-adapter';
import { encodeAccountAddress, isAccountAddress } from '@ujira/chain-adapter/codecs';
import { z } from 'zod';

import { messageFor } from './policy.js';
import { MAX_WIRE_BYTES, fromWire, toWire } from './wire.js';

export interface RemoteSignerOptions {
  /** The service's private network address, such as http://signer-chain:10000. */
  readonly baseUrl: string;
  /** This caller's service token; never logged. */
  readonly token: string;
  /** The deadline for one call, on top of the caller's own signal. */
  readonly timeoutMs: number;
  /** For tests; the global fetch when left out. */
  readonly fetch?: typeof fetch;
}

const bytesOf = (length: number) =>
  z.instanceof(Uint8Array).refine((value) => value.length === length);

export const signatureSchema = z.strictObject({
  kind: z.literal('ed25519'),
  signature: bytesOf(64),
  publicKey: bytesOf(32),
});

const signResponse = z.strictObject({ signature: signatureSchema });
const addressResponse = z.strictObject({
  address: z.strictObject({ network: z.enum(NETWORK_IDS), value: z.string().max(128) }),
});
const healthResponse = z.strictObject({
  health: z.strictObject({
    state: z.enum(['healthy', 'degraded', 'down']),
    checkedAt: z.bigint(),
    signP95Ms: z.number().nonnegative().nullable(),
    reasons: z.array(z.string().max(64)).max(32),
  }),
});
const errorResponse = z.object({ error: z.object({ code: z.string().max(64) }) });

/** The port error a failed response stands for. */
function failure(status: number, body: unknown, network?: SignerRef['network']) {
  const options = network === undefined ? {} : { network };
  const parsed = errorResponse.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : '';
  if (code === 'SIGNER_ADDRESS_MISMATCH') return new SignerAddressMismatchError(options);
  // A refused token is a configuration fault that no retry fixes.
  if (code === 'SIGNER_DENIED' || status === 401 || status === 403) {
    return new SignerDeniedError(options);
  }
  return new SignerUnavailableError(options);
}

export class RemoteSigner implements SignerProvider {
  readonly #baseUrl: URL;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: RemoteSignerOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? fetch;
  }

  /** The decoded body of a successful response; any failure is a port error. */
  protected async call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    opts: CallOptions,
    network?: SignerRef['network'],
  ): Promise<unknown> {
    const options = network === undefined ? {} : { network };
    const signals = [AbortSignal.timeout(this.#timeoutMs)];
    if (opts.signal !== undefined) signals.push(opts.signal);
    const signal = AbortSignal.any(signals);
    const send = async (): Promise<{ response: Response; text: string }> => {
      const response = await this.#fetch(new URL(path, this.#baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          'x-correlation-id': opts.correlationId,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: toWire(body) }),
        signal,
        redirect: 'error',
      });
      return { response, text: await response.text() };
    };
    let reply: { response: Response; text: string };
    try {
      // A reused connection can close just as a request is written to it,
      // and that request is lost with no answer. One more try on a fresh
      // connection, inside the same deadline, is safe: a signature changes
      // nothing and ed25519 gives the same one again.
      reply = await send().catch((error: unknown) => {
        if (signal.aborted) throw error;
        return send();
      });
    } catch (error) {
      // A timeout, an abort or a connection that stays down: the caller's
      // retry rules for SIGNER_UNAVAILABLE take it from here.
      throw new SignerUnavailableError({ ...options, cause: error });
    }
    const { response, text } = reply;
    const decoded = text.length > MAX_WIRE_BYTES ? undefined : fromWire(text);
    if (!response.ok) throw failure(response.status, decoded, network);
    return decoded;
  }

  async sign(ref: SignerRef, payload: SignPayload, opts: CallOptions): Promise<SignatureResult> {
    const body = await this.call('POST', '/v1/sign', { ref, payload }, opts, ref.network);
    const parsed = signResponse.safeParse(body);
    if (!parsed.success) throw new SignerUnavailableError({ network: ref.network });
    const result = parsed.data.signature;
    // The bytes this side expects for the key the service says it used.
    // A key that may not sign this payload, or a signature over anything
    // else, means the service cannot be trusted with this request.
    let message: Uint8Array;
    try {
      message = messageFor(ref, payload, encodeAccountAddress(result.publicKey));
    } catch {
      throw new SignerDeniedError({ network: ref.network });
    }
    if (!ed25519.verify(result.signature, message, result.publicKey)) {
      throw new SignerDeniedError({ network: ref.network });
    }
    return { kind: 'ed25519', signature: result.signature, publicKey: result.publicKey };
  }

  async address(ref: SignerRef, opts: CallOptions): Promise<ChainAddress> {
    const query = encodeURIComponent(toWire(ref));
    const body = await this.call('GET', `/v1/address?ref=${query}`, undefined, opts, ref.network);
    const parsed = addressResponse.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.address.network !== ref.network ||
      !isAccountAddress(parsed.data.address.value)
    ) {
      throw new SignerUnavailableError({ network: ref.network });
    }
    return parsed.data.address;
  }

  async health(opts: CallOptions): Promise<SignerHealth> {
    const parsed = healthResponse.safeParse(await this.call('GET', '/v1/health', undefined, opts));
    if (!parsed.success) throw new SignerUnavailableError();
    const { checkedAt, ...rest } = parsed.data.health;
    return { ...rest, checkedAt: checkedAt as UnixSeconds };
  }
}
