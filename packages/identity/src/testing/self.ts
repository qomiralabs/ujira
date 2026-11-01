// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A fake Self: a session API, a webhook sender that signs with a secret
// generated per test, and the provider event table. Nothing here talks to
// Self or holds a real credential. The payloads follow the fields UJIRA
// reads; the recorded deliveries from the Self spike replace them once they
// exist.

import { randomBytes } from 'node:crypto';

import type { UnixSeconds, Uuid } from '@ujira/chain-adapter';

import { SelfCreditsExhaustedError } from '../errors.js';
import type { SelfEnvironment } from '../self/config.js';
import type {
  ProviderEventRecord,
  ProviderEventStore,
  SelfClient,
  SelfSession,
  SelfSessionRequest,
} from '../self/ports.js';
import { SELF_SIGNATURE_HEADER, selfSignature } from '../self/signature.js';
import type { WebhookHeaders } from '../self/signature.js';

import type { FakeFailure } from './attestation.js';

export class InMemoryProviderEventStore implements ProviderEventStore {
  readonly #events = new Map<string, ProviderEventRecord>();

  #key(provider: string, account: string, eventKey: string): string {
    return `${provider}/${account}/${eventKey}`;
  }

  has(provider: 'self', providerAccount: string, eventKey: string): Promise<boolean> {
    return Promise.resolve(this.#events.has(this.#key(provider, providerAccount, eventKey)));
  }

  record(event: ProviderEventRecord): Promise<'recorded' | 'duplicate'> {
    const key = this.#key(event.provider, event.providerAccount, event.eventKey);
    if (this.#events.has(key)) return Promise.resolve('duplicate');
    this.#events.set(key, event);
    return Promise.resolve('recorded');
  }

  all(): ProviderEventRecord[] {
    return [...this.#events.values()];
  }
}

export class FakeSelfClient implements SelfClient {
  readonly requests: SelfSessionRequest[] = [];
  failure: FakeFailure | 'credits_exhausted' | null = null;
  readonly #now: () => UnixSeconds;
  #next = 0;

  constructor(now: () => UnixSeconds) {
    this.#now = now;
  }

  createSession(req: SelfSessionRequest): Promise<SelfSession> {
    if (this.failure === 'hang') return new Promise<SelfSession>(() => undefined);
    if (this.failure === 'credits_exhausted') {
      return Promise.reject(new SelfCreditsExhaustedError());
    }
    if (this.failure !== null) return Promise.reject(this.failure);
    this.requests.push(req);
    this.#next += 1;
    const sessionId = `sess_${String(this.#next)}`;
    return Promise.resolve({
      sessionId,
      url: `https://self.test/session/${sessionId}`,
      expiresAt: (this.#now() + BigInt(req.ttlSeconds)) as UnixSeconds,
    });
  }
}

export type SelfOutcome = 'valid' | 'invalid' | 'error' | 'expired';

export interface SelfEventFields {
  readonly externalUuid: Uuid;
  readonly status: SelfOutcome;
  readonly verificationId?: string;
  readonly nullifier?: string | null;
  readonly errorCode?: string | null;
  readonly completedAt: UnixSeconds;
  readonly environment?: SelfEnvironment;
  readonly flowId?: string;
  readonly flowVersion?: string;
}

/** What a webhook POST carries: the exact bytes and the headers. */
export interface SelfDelivery {
  readonly rawBody: Uint8Array;
  readonly headers: WebhookHeaders;
}

/**
 * Builds and signs deliveries as Self would. The proof and user context
 * fields are filled with marker values so a test can prove none of them is
 * ever stored.
 */
export class FakeSelfProvider {
  /** Generated per instance; never a real secret. */
  readonly secret: Uint8Array = randomBytes(32);
  readonly flowId: string;
  readonly flowVersion: string;
  readonly environment: SelfEnvironment;
  #count = 0;

  constructor(options: {
    readonly flowId: string;
    readonly flowVersion: string;
    readonly environment: SelfEnvironment;
  }) {
    this.flowId = options.flowId;
    this.flowVersion = options.flowVersion;
    this.environment = options.environment;
  }

  /** A fresh verification id, as Self gives one per completed session. */
  nextVerificationId(): string {
    this.#count += 1;
    return `ver_${String(this.#count)}_${randomBytes(4).toString('hex')}`;
  }

  body(fields: SelfEventFields): Record<string, unknown> {
    return {
      type: 'verification.completed',
      environment: fields.environment ?? this.environment,
      flow_id: fields.flowId ?? this.flowId,
      flow_version: fields.flowVersion ?? this.flowVersion,
      verification_id: fields.verificationId ?? this.nextVerificationId(),
      external_uuid: fields.externalUuid,
      status: fields.status,
      nullifier:
        fields.nullifier === undefined
          ? fields.status === 'valid'
            ? `nullifier-${randomBytes(8).toString('hex')}`
            : null
          : fields.nullifier,
      error_code: fields.errorCode ?? null,
      completed_at: Number(fields.completedAt),
      proof: { publicSignals: ['PROOF-MARKER-1', 'PROOF-MARKER-2'], pi_a: ['PROOF-MARKER-3'] },
      user_context_data: 'CONTEXT-MARKER',
    };
  }

  /** Signs the exact bytes with the given time, or with this provider's secret by default. */
  sign(
    body: unknown,
    time: UnixSeconds,
    options: { readonly secret?: Uint8Array; readonly raw?: string } = {},
  ): SelfDelivery {
    const rawBody = new TextEncoder().encode(options.raw ?? JSON.stringify(body));
    const signature = selfSignature(options.secret ?? this.secret, time, rawBody);
    return {
      rawBody,
      headers: { [SELF_SIGNATURE_HEADER]: `t=${time.toString()},v1=${signature}` },
    };
  }

  deliver(fields: SelfEventFields, time: UnixSeconds = fields.completedAt): SelfDelivery {
    return this.sign(this.body(fields), time);
  }
}
