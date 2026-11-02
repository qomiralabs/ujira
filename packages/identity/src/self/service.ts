// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Self Pre-KYC for recipients. UJIRA starts a session and then trusts only
// a signed webhook. From the result it keeps references, a status and an
// HMAC of the nullifier; the proof, the raw body and any personal value are
// never stored, only a SHA-256 of the body.
//
// A webhook is answered 200 whenever it was genuine, even when it changes
// nothing, so Self stops retrying it. Only a bad signature, a body that does
// not parse, or an event for another environment or flow gets a 400.

import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { Uuid, UnixSeconds } from '@ujira/chain-adapter';
import { z } from 'zod';

import {
  IdentityConflictError,
  IdentityInputError,
  ProviderUnavailableError,
  SelfCreditsExhaustedError,
  SelfSessionRefusedError,
  issuesOf,
} from '../errors.js';
import type { IdentityUpdate } from '../ports.js';
import { checkedScope } from '../service.js';
import { withTimeout } from '../timeout.js';
import type { IdentityContext, IdentityRecord } from '../types.js';

import {
  SELF_SESSION_TTL_SECONDS,
  SELF_VERIFICATION_VALIDITY_SECONDS,
  checkSelfApiKey,
  selfFlowRules,
} from './config.js';
import type { SelfSession, SelfVerificationPorts, SelfWebhook } from './ports.js';
import { selfWebhookSchema } from './ports.js';
import type { WebhookHeaders } from './signature.js';

export interface StartSelfSessionRequest {
  readonly recipientId: Uuid;
  readonly returnUrl: string;
}

export interface StartedSelfSession extends SelfSession {
  readonly identityId: Uuid;
  /** True when an unexpired pending session was handed back instead of a new one. */
  readonly reused: boolean;
}

export interface SelfWebhookRequest {
  readonly rawBody: Uint8Array;
  readonly headers: WebhookHeaders;
  readonly correlationId: string;
}

/** What happened to a genuine delivery. */
export type SelfWebhookResult = 'applied' | 'duplicate' | 'stale' | 'ignored';

export type SelfWebhookResponse =
  | { readonly status: 200; readonly body: { readonly result: SelfWebhookResult } }
  | {
      readonly status: 400;
      readonly body: {
        readonly code: 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_PAYLOAD_INVALID' | 'WEBHOOK_REJECTED';
      };
    };

export interface SelfVerification {
  startSelfSession(ctx: IdentityContext, req: StartSelfSessionRequest): Promise<StartedSelfSession>;
  handleWebhook(req: SelfWebhookRequest): Promise<SelfWebhookResponse>;
}

const startSchema = z.strictObject({
  recipientId: z.uuid(),
  returnUrl: z.url({ protocol: /^https$/ }).max(2048),
});

// Outcomes that end a verification. A session that errored or expired never
// overrides one of these.
const TERMINAL: ReadonlySet<string> = new Set(['verified', 'rejected']);

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function rejected(
  code: 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_PAYLOAD_INVALID' | 'WEBHOOK_REJECTED',
): SelfWebhookResponse {
  return { status: 400, body: { code } };
}

function ok(result: SelfWebhookResult): SelfWebhookResponse {
  return { status: 200, body: { result } };
}

function parseBody(rawBody: Uint8Array): SelfWebhook | null {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
  } catch {
    // The body is the provider's; its parse error quotes it, so it is dropped.
    return null;
  }
  const parsed = selfWebhookSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function createSelfVerification(ports: SelfVerificationPorts): SelfVerification {
  const { self, store, credentials } = ports;
  checkSelfApiKey(credentials.apiKey, ports.deployment, self.environment);
  if (credentials.nullifierKey.length < 32) {
    throw new RangeError('the nullifier key must be at least 32 bytes');
  }
  const providerAccount = `${self.environment}:${self.flowId}`;
  const nullifierHmac = (nullifier: string): string =>
    createHmac('sha256', credentials.nullifierKey).update(nullifier, 'utf8').digest('hex');

  /** The identity change a result makes, or null when it must not touch the row. */
  async function updateFor(
    row: IdentityRecord,
    event: SelfWebhook,
    rawSha256: string,
    correlationId: string,
  ): Promise<IdentityUpdate | null> {
    const completedAt = BigInt(event.completed_at) as UnixSeconds;
    // Out of order: an older result than the one already applied changes nothing.
    if (row.lastCheckedAt !== null && completedAt < row.lastCheckedAt) return null;
    const terminal = event.status === 'valid' || event.status === 'invalid';
    if (!terminal && TERMINAL.has(row.status)) return null;

    const base: IdentityUpdate = {
      providerRef: event.verification_id,
      providerStatus: event.status,
      flowRef: `${event.flow_id}@${event.flow_version}`,
      rawSha256,
      lastCheckedAt: completedAt,
      pendingSession: null,
    };
    if (event.status === 'invalid') {
      return { ...base, status: 'rejected', failureReason: 'invalid' };
    }
    if (event.status === 'expired') {
      return { ...base, status: 'pending', failureReason: 'session_expired' };
    }
    if (event.status === 'error') {
      if (event.error_code === 'SELF_CREDITS_EXHAUSTED') {
        ports.alerts.selfCreditsExhausted({ environment: self.environment, correlationId });
        return { ...base, status: 'pending', failureReason: 'provider_unavailable' };
      }
      return { ...base, status: 'pending', failureReason: 'provider_error' };
    }
    const hmac = nullifierHmac(event.nullifier ?? '');
    const existing = await store.verifiedByNullifier(row.scope.principalId, hmac);
    if (existing !== null && existing.recipientId !== row.recipientId) {
      ports.alerts.duplicatePerson({
        scope: row.scope,
        recipientId: row.recipientId,
        existingRecipientId: existing.recipientId,
      });
      return {
        ...base,
        status: 'rejected',
        failureReason: 'duplicate_person',
        nullifierHmac: hmac,
      };
    }
    return {
      ...base,
      status: 'verified',
      assurance: 'document_zk',
      nullifierHmac: hmac,
      failureReason: null,
      expiresAt: (completedAt + SELF_VERIFICATION_VALIDITY_SECONDS) as UnixSeconds,
    };
  }

  return {
    async startSelfSession(ctx, rawRequest) {
      const scope = checkedScope(ctx);
      const parsed = startSchema.safeParse(rawRequest);
      if (!parsed.success) throw new IdentityInputError(issuesOf(parsed.error));
      const recipientId = parsed.data.recipientId as Uuid;
      if (!ports.config().providers.self.enabled) throw new ProviderUnavailableError();

      const recipient = await store.recipient(scope, recipientId);
      if (recipient?.status !== 'active') throw new SelfSessionRefusedError('recipient_inactive');
      const now = ports.clock.nowSeconds();
      let row = (await store.identities(scope, recipientId)).find((r) => r.provider === 'self');
      if (row?.status === 'revoked') throw new SelfSessionRefusedError('revoked');
      if (row?.status === 'verified' && (row.expiresAt === null || row.expiresAt > now)) {
        throw new SelfSessionRefusedError('already_verified');
      }
      if (row?.pendingSession != null && row.pendingSession.expiresAt > now) {
        return { ...row.pendingSession, identityId: row.id, reused: true };
      }
      if (row === undefined) {
        row = {
          scope,
          id: randomUUID() as Uuid,
          recipientId,
          provider: 'self',
          providerAccount: null,
          status: 'pending',
          assurance: 'none',
          expiresAt: null,
          providerRef: null,
          providerStatus: null,
          flowRef: null,
          nullifierHmac: null,
          pendingSession: null,
          failureReason: null,
          rawSha256: null,
          lastCheckedAt: null,
        };
        await store.createIdentity(row);
      }

      const identityId = row.id;
      let session: SelfSession;
      try {
        session = await withTimeout(self.callTimeoutMs, ctx.signal, (signal) =>
          ports.client.createSession(
            {
              environment: self.environment,
              flowId: self.flowId,
              flowVersion: self.flowVersion,
              rules: selfFlowRules(self),
              externalUuid: identityId,
              returnUrl: parsed.data.returnUrl,
              ttlSeconds: SELF_SESSION_TTL_SECONDS,
            },
            { correlationId: ctx.correlationId, signal },
          ),
        );
      } catch (error) {
        if (error instanceof SelfCreditsExhaustedError) {
          ports.alerts.selfCreditsExhausted({
            environment: self.environment,
            correlationId: ctx.correlationId,
          });
          throw new ProviderUnavailableError({ cause: error });
        }
        throw error;
      }
      // A new session starts a new attempt: the row is pending again.
      await store.updateIdentity(scope, identityId, {
        status: 'pending',
        pendingSession: session,
      });
      return { ...session, identityId, reused: false };
    },

    async handleWebhook(req) {
      const now = ports.clock.nowSeconds();
      if (!ports.verifier.verify(req.rawBody, req.headers, now).ok) {
        return rejected('WEBHOOK_SIGNATURE_INVALID');
      }
      const event = parseBody(req.rawBody);
      if (event === null) return rejected('WEBHOOK_PAYLOAD_INVALID');
      if (event.status === 'valid' && (event.nullifier ?? '') === '') {
        return rejected('WEBHOOK_PAYLOAD_INVALID');
      }
      if (event.environment !== self.environment || event.flow_id !== self.flowId) {
        return rejected('WEBHOOK_REJECTED');
      }

      const eventKey = `${event.verification_id}-completed`;
      if (await ports.events.has('self', providerAccount, eventKey)) return ok('duplicate');

      const rawSha256 = sha256Hex(req.rawBody);
      const row = await store.identityById(event.external_uuid as Uuid);
      let result: SelfWebhookResult = 'ignored';
      // An unknown row, another provider's row, or one erased since the
      // session started takes nothing from the event.
      if (row !== null && row.provider === 'self' && row.status !== 'revoked') {
        const update = await updateFor(row, event, rawSha256, req.correlationId);
        if (update === null) {
          result = 'stale';
        } else {
          try {
            await store.updateIdentity(row.scope, row.id, update);
            result = 'applied';
          } catch (error) {
            // Another delivery verified the same person for another
            // recipient between the check and the write. The store's unique
            // rule caught it; record it the same way.
            if (!(error instanceof IdentityConflictError)) throw error;
            const existing = await store.verifiedByNullifier(
              row.scope.principalId,
              update.nullifierHmac ?? '',
            );
            ports.alerts.duplicatePerson({
              scope: row.scope,
              recipientId: row.recipientId,
              existingRecipientId: existing?.recipientId ?? row.recipientId,
            });
            await store.updateIdentity(row.scope, row.id, {
              ...update,
              status: 'rejected',
              failureReason: 'duplicate_person',
              assurance: 'none',
              expiresAt: null,
            });
            result = 'applied';
          }
        }
      }
      // Recorded after the row changes: applying the same result twice gives
      // the same row, so a crash between the two is retried safely.
      const recorded = await ports.events.record({
        provider: 'self',
        providerAccount,
        eventKey,
        rawSha256,
        receivedAt: now,
      });
      return ok(recorded === 'duplicate' ? 'duplicate' : result);
    },
  };
}
