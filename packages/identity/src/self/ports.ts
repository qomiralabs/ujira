// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// What the Self verification flow is given. The client and the verifier are
// Self's; the event store is the provider event dedupe table; the alerts go
// to operations and to the principal. Each has an in-memory or fake version
// in @ujira/identity/testing until the real ones exist.

import type { CallOptions, TenantScope, UnixSeconds, Uuid } from '@ujira/chain-adapter';
import { z } from 'zod';

import type { IdentityConfig } from '../config.js';
import type { IdentityStore, IdentityWriteStore } from '../ports.js';

import type { Deployment, SelfConfig, SelfEnvironment, SelfFlowRules } from './config.js';
import type { SelfWebhookVerifier } from './signature.js';

export interface SelfSessionRequest {
  readonly environment: SelfEnvironment;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly rules: SelfFlowRules;
  /** The identity row id, which Self sends back as external_uuid. */
  readonly externalUuid: Uuid;
  readonly returnUrl: string;
  readonly ttlSeconds: number;
}

export interface SelfSession {
  readonly sessionId: string;
  /** The hosted page the recipient opens. Carries no personal data. */
  readonly url: string;
  readonly expiresAt: UnixSeconds;
}

/**
 * Self's session API. Throws SelfCreditsExhaustedError when the account is
 * out of credits, and any other error for anything else.
 */
export interface SelfClient {
  createSession(req: SelfSessionRequest, opts: CallOptions): Promise<SelfSession>;
}

/** One delivery of one provider event. No tenant: the provider sends none. */
export interface ProviderEventRecord {
  readonly provider: 'self';
  /** The Self environment and flow the event came from. */
  readonly providerAccount: string;
  /** `<verification_id>-completed` for Self results. */
  readonly eventKey: string;
  readonly rawSha256: string;
  readonly receivedAt: UnixSeconds;
}

/** The provider event dedupe table: append only, unique per provider, account and key. */
export interface ProviderEventStore {
  has(provider: 'self', providerAccount: string, eventKey: string): Promise<boolean>;
  /** Returns 'duplicate' when another delivery recorded the same key first. */
  record(event: ProviderEventRecord): Promise<'recorded' | 'duplicate'>;
}

export interface IdentityAlerts {
  /** Operations: Self ran out of credits. Never shown to the recipient as their fault. */
  selfCreditsExhausted(e: {
    readonly environment: SelfEnvironment;
    readonly correlationId: string;
  }): void;
  /** The principal: a second recipient of theirs verified as the same person. */
  duplicatePerson(e: {
    readonly scope: TenantScope;
    readonly recipientId: Uuid;
    readonly existingRecipientId: Uuid;
  }): void;
}

export interface SelfCredentials {
  /** Self's API key, checked against the deployment, never logged. */
  readonly apiKey: string;
  /** HMAC key for nullifiers, at least 32 bytes, so the raw nullifier is never stored. */
  readonly nullifierKey: Uint8Array;
}

export interface SelfVerificationPorts {
  readonly store: IdentityStore & IdentityWriteStore;
  readonly events: ProviderEventStore;
  readonly client: SelfClient;
  readonly verifier: SelfWebhookVerifier;
  readonly alerts: IdentityAlerts;
  readonly clock: { nowSeconds(): UnixSeconds };
  readonly config: () => IdentityConfig;
  readonly self: SelfConfig;
  readonly deployment: Deployment;
  readonly credentials: SelfCredentials;
}

/**
 * The webhook body as far as UJIRA reads it. Anything else Self sends,
 * including the proof and user context data, is dropped by the parse and
 * never stored; only a SHA-256 of the raw body is kept.
 */
export const selfWebhookSchema = z.object({
  type: z.literal('verification.completed'),
  environment: z.enum(['test', 'live']),
  flow_id: z.string().min(1).max(128),
  flow_version: z.string().min(1).max(64),
  verification_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  external_uuid: z.uuid(),
  status: z.enum(['valid', 'invalid', 'error', 'expired']),
  nullifier: z.string().min(1).max(256).nullish(),
  error_code: z.string().max(64).nullish(),
  completed_at: z.int().min(0),
});

export type SelfWebhook = z.output<typeof selfWebhookSchema>;
