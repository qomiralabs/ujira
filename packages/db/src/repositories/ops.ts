// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The app's only way into schema ops: narrow functions that run as
// ujira_ops, called inside db.unscoped(), since these rows belong to no
// tenant. They hold no tenant data, so they sit outside the cross-tenant
// matrix; the no-customer-data tests are what keep that true.

import { sql, type Kysely } from 'kysely';

import type { Schema } from '../schema.generated.js';

type Tx = Kysely<Schema>;

export interface ExecutorLease {
  readonly accountRef: string;
  // int8 comes back from pg as text, and stays a bigint from here on.
  readonly nextSequence: bigint;
  readonly leaseExpiresAt: Date;
}

export interface RoutingConfig {
  readonly version: bigint;
  readonly document: unknown;
}

export interface RateLimitBucket {
  // A digest of what is being limited, never a tenant id: the table refuses
  // anything else, because this schema holds no customer data.
  readonly key: string;
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface RateLimitTaken {
  readonly key: string;
  // The whole request's answer: every bucket gave a token, or none did.
  readonly allowed: boolean;
  // What the bucket holds now. Fractional, and a rate, so a number is fine here.
  readonly tokens: number;
}

export const SECURITY_EVENT_KINDS = Object.freeze([
  'sign_in_failed',
  'otp_failed',
  'mfa_failed',
  'token_invalid',
  'token_env_mismatch',
  'csrf_failed',
  'callback_signature_invalid',
  'unresolved_identity_event',
] as const);
export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number];

export interface NewSecurityEvent {
  readonly kind: SecurityEventKind;
  // HMAC-SHA-256 under a key the caller holds, never the value itself: the table
  // refuses anything that is not 32 bytes.
  readonly emailHmac?: Buffer;
  readonly ipHmac?: Buffer;
  // The public part of a key, never the key.
  readonly tokenPrefix?: string;
}

export const executors = {
  // A free account on the network for this holder, or undefined when every
  // account is held. Concurrent callers never get the same one.
  lease: async (
    db: Tx,
    input: { readonly network: string; readonly holder: string; readonly leaseSeconds: number },
  ): Promise<ExecutorLease | undefined> => {
    const result = await sql<{
      account_ref: string;
      next_sequence: string;
      lease_expires_at: Date;
    }>`
      select account_ref, next_sequence, lease_expires_at
        from ops.lease_executor(${input.network}, ${input.holder}, ${input.leaseSeconds})
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      accountRef: row.account_ref,
      nextSequence: BigInt(row.next_sequence),
      leaseExpiresAt: row.lease_expires_at,
    };
  },

  // True when this holder still held the account. The sequence never moves
  // backwards, whatever is passed.
  release: async (
    db: Tx,
    input: {
      readonly network: string;
      readonly accountRef: string;
      readonly holder: string;
      readonly sequenceReached: bigint;
    },
  ): Promise<boolean> => {
    const result = await sql<{ released: boolean }>`
      select ops.release_executor(
        ${input.network}, ${input.accountRef}, ${input.holder}, ${input.sequenceReached.toString()}::bigint
      ) as released
    `.execute(db);
    return result.rows[0]?.released === true;
  },
};

export const securityEvents = {
  record: async (db: Tx, event: NewSecurityEvent): Promise<void> => {
    await sql`
      select ops.record_security_event(
        ${event.kind},
        ${event.emailHmac ?? null}::bytea,
        ${event.tokenPrefix ?? null}::text,
        ${event.ipHmac ?? null}::bytea
      )
    `.execute(db);
  },

  // Removes one batch of events past their 90 days and says how many, so a job
  // keeps calling until this says none. Needs the retention login.
  deleteExpired: async (db: Tx, batchSize: number): Promise<number> => {
    const result = await sql<{ removed: string }>`
      select ops.delete_expired_security_events(${batchSize}::integer) as removed
    `.execute(db);
    return Number(result.rows[0]?.removed ?? '0');
  },
};

export const rateLimits = {
  // Refills the buckets and takes a token from each, all or none, in one call.
  take: async (db: Tx, buckets: readonly RateLimitBucket[]): Promise<RateLimitTaken[]> => {
    const result = await sql<{ taken_key: string; allowed: boolean; remaining: string }>`
      select taken_key, allowed, remaining
        from ops.take_rate_limit_tokens(
          ${buckets.map((bucket) => bucket.key)}::text[],
          ${buckets.map((bucket) => bucket.capacity)}::integer[],
          ${buckets.map((bucket) => bucket.refillPerSecond)}::integer[]
        )
    `.execute(db);
    return result.rows.map((row) => ({
      key: row.taken_key,
      allowed: row.allowed,
      tokens: Number(row.remaining),
    }));
  },
};

export const routingConfig = {
  // The live configuration, or undefined before one is activated.
  active: async (db: Tx): Promise<RoutingConfig | undefined> => {
    const result = await sql<{ version: string; document: unknown }>`
      select version, document from ops.active_routing_config()
    `.execute(db);
    const row = result.rows[0];
    return row === undefined ? undefined : { version: BigInt(row.version), document: row.document };
  },
};

export interface IdentityProviderEvent {
  readonly provider: string;
  readonly providerAccount: string;
  readonly eventKey: string;
  // 32 bytes. The digest of the body, which is discarded.
  readonly rawSha256: Buffer;
}

// Deduplicates what identity providers deliver. A delivery arrives before anyone
// can know whose it is, so these rows belong to no tenant, and the table holds
// only the provider's event key and a digest.
export const identityProviderEvents = {
  // True when this delivery is the first with its key.
  record: async (db: Tx, event: IdentityProviderEvent): Promise<boolean> => {
    const result = await sql<{ stored: boolean }>`
      select ops.record_identity_provider_event(
        ${event.provider}, ${event.providerAccount}, ${event.eventKey}, ${event.rawSha256}
      ) as stored
    `.execute(db);
    return result.rows[0]?.stored === true;
  },

  seen: async (
    db: Tx,
    key: { readonly provider: string; readonly providerAccount: string; readonly eventKey: string },
  ): Promise<boolean> => {
    const result = await sql<{ seen: boolean }>`
      select ops.identity_provider_event_seen(
        ${key.provider}, ${key.providerAccount}, ${key.eventKey}
      ) as seen
    `.execute(db);
    return result.rows[0]?.seen === true;
  },
};
