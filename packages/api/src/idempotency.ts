// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every tenant write takes an Idempotency-Key, so a client that never saw an
// answer can safely ask again. What a retry gets:
//
// - the same request, finished: the stored answer, unchanged, marked as a replay;
// - the same request, still running: 409, with Retry-After;
// - a different request under that key: 422.
//
// The store's unique constraint decides who wins a key, so this holds across
// instances. What it cannot cover is a process that dies mid request: the lease
// runs out and a retry runs the handler again. So a handler that moves money must
// also write `context.idempotencyKey` under a unique constraint of its own.

import { createHash } from 'node:crypto';

import type { CallOptions, Tenant } from './auth.js';
import { ApiError } from './errors.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Long enough for a handler to outlive the request deadline, since a deadline
 * answers the client without stopping the work. A shorter lease would let a retry
 * start while the first attempt is still running.
 */
export const IDEMPOTENCY_LEASE_SECONDS = 120;

const KEY = /^[A-Za-z0-9_.:-]{1,255}$/;

export type Reservation =
  | { readonly kind: 'started'; readonly leaseId: string }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'mismatch' }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly requestId: string;
      readonly body: string;
    };

export interface ReserveRequest {
  readonly key: string;
  readonly requestSha256: Buffer;
  readonly leaseSeconds: number;
}

export interface FinishRequest {
  readonly key: string;
  readonly leaseId: string;
  readonly status: number;
  readonly requestId: string;
  readonly body: string;
}

export interface IdempotencyStore {
  readonly reserve: (
    tenant: Tenant,
    request: ReserveRequest,
    call: CallOptions,
  ) => Promise<Reservation>;
  /** False when this attempt lost the key, in which case the newer attempt's answer stands. */
  readonly complete: (
    tenant: Tenant,
    request: FinishRequest,
    call: CallOptions,
  ) => Promise<boolean>;
  readonly release: (
    tenant: Tenant,
    request: { readonly key: string; readonly leaseId: string },
    call: CallOptions,
  ) => Promise<boolean>;
}

/** The header's value, or a refusal. Names no value, since the client chose it. */
export function idempotencyKeyOf(headers: Headers): string {
  const key = headers.get(IDEMPOTENCY_HEADER);
  if (key === null || !KEY.test(key)) throw new ApiError('IDEMPOTENCY_KEY_INVALID');
  return key;
}

/**
 * What makes two requests the same one: the method, the path as sent, the query
 * and the exact body bytes. Each is framed by its length, so no part can run into
 * the next. Bytes rather than parsed JSON, because a key promises the same request
 * and not merely an equivalent one.
 */
export function requestFingerprint(method: string, url: URL, body: Uint8Array | null): Buffer {
  const hash = createHash('sha256');
  for (const part of [method, url.pathname, url.search]) {
    const bytes = Buffer.from(part, 'utf8');
    hash.update(`${String(bytes.byteLength)}:`).update(bytes);
  }
  if (body !== null) hash.update(`${String(body.byteLength)}:`).update(body);
  return hash.digest();
}

/**
 * Whether an answer is final, and so stored and replayed. A 5xx or a 429 says to
 * try again, so a retry has to run.
 */
export function isFinalStatus(status: number): boolean {
  return status < 500 && status !== 429;
}

/** Keeps records in memory, for tests and for a server that refuses every key. */
export function memoryIdempotencyStore(now: () => Date = () => new Date()): IdempotencyStore {
  interface Row {
    requestSha256: Buffer;
    leaseId: string | null;
    leaseExpiresAt: number;
    answer: { status: number; requestId: string; body: string } | null;
  }
  const rows = new Map<string, Row>();
  let leases = 0;
  const idOf = (tenant: Tenant, key: string): string =>
    `${tenant.principalId}:${tenant.projectId}:${key}`;
  return {
    reserve: (tenant, request) => {
      const id = idOf(tenant, request.key);
      const row = rows.get(id);
      const at = now().getTime();
      const free =
        row === undefined ||
        (row.leaseId !== null &&
          row.leaseExpiresAt <= at &&
          row.requestSha256.equals(request.requestSha256));
      if (free) {
        leases += 1;
        const leaseId = `lease-${String(leases)}`;
        rows.set(id, {
          requestSha256: request.requestSha256,
          leaseId,
          leaseExpiresAt: at + request.leaseSeconds * 1000,
          answer: null,
        });
        return Promise.resolve({ kind: 'started', leaseId });
      }
      if (!row.requestSha256.equals(request.requestSha256)) {
        return Promise.resolve({ kind: 'mismatch' });
      }
      if (row.answer === null) return Promise.resolve({ kind: 'in_progress' });
      return Promise.resolve({ kind: 'replay', ...row.answer });
    },
    complete: (tenant, request) => {
      const row = rows.get(idOf(tenant, request.key));
      if (row?.leaseId !== request.leaseId) return Promise.resolve(false);
      row.leaseId = null;
      row.answer = {
        status: request.status,
        requestId: request.requestId,
        body: request.body,
      };
      return Promise.resolve(true);
    },
    release: (tenant, request) => {
      const row = rows.get(idOf(tenant, request.key));
      if (row?.leaseId !== request.leaseId) return Promise.resolve(false);
      row.leaseExpiresAt = now().getTime();
      return Promise.resolve(true);
    },
  };
}
