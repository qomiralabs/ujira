// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The signer service: the only process that holds signing permission. It
// authenticates its caller, reads the request, checks it against the ref
// kinds it serves and its policy, and only then asks its backend, whose own
// policy runs again before any key is used. Responses carry a code and
// never a reason, so a caller cannot probe the policy. DESTINATION_INVALID is
// the one refusal with a code of its own: the caller has to tell a recipient
// to fix the address, and it says nothing the caller could not read itself.

import { createHash, randomUUID } from 'node:crypto';

import { ChainAdapterError, SignerDeniedError } from '@ujira/chain-adapter';
import type { SignPayload, SignerProvider, SignerRef, UnixSeconds } from '@ujira/chain-adapter';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { parseAttestationFields, parsePayload, parseRef } from '../schemas.js';
import { MAX_WIRE_BYTES, fromWire, toWire } from '../wire.js';

import { tokenAuthenticator } from './auth.js';
import type { ServiceCaller } from './auth.js';
import { writeLog } from './log.js';
import type { SignerLogFields, SignerLogLevel, SignerLogger } from './log.js';
import type { ServicePolicy } from './policy.js';

export interface SignerServiceOptions {
  /** The backend that holds the keys. */
  readonly provider: SignerProvider;
  readonly policy: ServicePolicy;
  /** Who may call; any other token is refused. */
  readonly callers: readonly ServiceCaller[];
  readonly logger: SignerLogger;
  /** The deadline for one backend call. */
  readonly backendTimeoutMs: number;
  readonly now?: () => Date;
  readonly newRequestId?: () => string;
}

/** HTTP status for each code a service answers with. */
const STATUS: Readonly<Record<string, 401 | 403 | 404 | 413 | 422 | 500 | 503>> = Object.freeze({
  UNAUTHENTICATED: 401,
  SIGNER_DENIED: 403,
  NOT_FOUND: 404,
  TOO_LARGE: 413,
  DESTINATION_INVALID: 422,
  SIGNER_ADDRESS_MISMATCH: 500,
  INTERNAL: 500,
  SIGNER_UNAVAILABLE: 503,
});

function codeOf(error: unknown): string {
  if (error instanceof ChainAdapterError && error.code in STATUS) return error.code;
  return 'INTERNAL';
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(toWire(value)).digest('hex');
}

function reply(c: Context, status: number, body: unknown): Response {
  return c.body(toWire(body), status as 200, { 'content-type': 'application/json' });
}

export function createSignerService(options: SignerServiceOptions): Hono {
  const authenticate = tokenAuthenticator(options.callers);
  const now = options.now ?? (() => new Date());
  const newRequestId = options.newRequestId ?? randomUUID;
  const { provider, policy, logger } = options;
  const app = new Hono();

  // One request, one id and one clock reading, carried into the backend
  // call so its logs line up.
  const begin = (c: Context, route: string) => {
    const requestId = newRequestId();
    const started = now();
    const log = (level: SignerLogLevel, event: string, fields: SignerLogFields): void => {
      const at = now();
      writeLog(logger, level, event, requestId, at, {
        route,
        durationMs: at.getTime() - started.getTime(),
        ...fields,
      });
    };
    const caller = authenticate(c.req.header('authorization') ?? null);
    return { requestId, started, log, caller };
  };

  const fail = (
    c: Context,
    log: (level: SignerLogLevel, event: string, fields: SignerLogFields) => void,
    error: unknown,
    fields: SignerLogFields,
  ): Response => {
    const code = codeOf(error);
    const status = STATUS[code] ?? 500;
    const level: SignerLogLevel = status >= 500 ? 'error' : 'warn';
    log(level, status >= 500 ? 'request_failed' : 'request_refused', {
      ...fields,
      status,
      errorCode: code,
    });
    return reply(c, status, { error: { code } });
  };

  const served = (ref: SignerRef): SignerRef => {
    if (!policy.refKinds.has(ref.kind)) throw new SignerDeniedError({ network: ref.network });
    return ref;
  };

  const callOptions = (requestId: string) => ({
    correlationId: requestId,
    signal: AbortSignal.timeout(options.backendTimeoutMs),
  });

  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_WIRE_BYTES,
      onError: (c) => reply(c, 413, { error: { code: 'TOO_LARGE' } }),
    }),
  );

  // The one path to a signature: authenticate, read, check, then ask the
  // backend. The routes differ only in how a request reads as a ref and a
  // payload.
  const signRoute = async (
    c: Context,
    route: string,
    read: (raw: Record<string, unknown>) => { ref: SignerRef; payload: SignPayload },
  ): Promise<Response> => {
    const { requestId, started, log, caller } = begin(c, route);
    if (caller === null) return unauthenticated(c, log);
    const fields: { -readonly [K in keyof SignerLogFields]: SignerLogFields[K] } = { caller };
    try {
      const body = fromWire(await c.req.text());
      const raw =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const { ref, payload } = read(raw);
      fields.refKind = ref.kind;
      fields.network = ref.network;
      fields.payloadKind = payload.kind;
      fields.payloadHash = hashOf(payload);
      const decision = await policy.check(ref, payload, {
        caller,
        now: BigInt(Math.floor(started.getTime() / 1000)) as UnixSeconds,
        opts: { correlationId: requestId },
      });
      if (decision.tenant !== null) {
        fields.principalId = decision.tenant.principalId;
        fields.projectId = decision.tenant.projectId;
      }
      // The key manager's id goes in this service's log and stops here: a
      // caller has no use for it and no way to reach the key manager.
      const { requestId: keyRequestId, ...signature } = await provider.sign(
        ref,
        payload,
        callOptions(requestId),
      );
      if (keyRequestId !== undefined) fields.keyRequestId = keyRequestId;
      log('info', 'sign_ok', { ...fields, status: 200 });
      return reply(c, 200, { signature });
    } catch (error) {
      return fail(c, log, error, fields);
    }
  };

  app.post('/v1/sign', (c) =>
    signRoute(c, '/v1/sign', (raw) => ({
      ref: served(parseRef(raw['ref'])),
      payload: parsePayload(raw['payload']),
    })),
  );

  // The attester's form: structured fields and nothing else, so there is no
  // way to hand this route bytes to sign.
  app.post('/v1/attest', (c) =>
    signRoute(c, '/v1/attest', (raw) => {
      const fields = parseAttestationFields(raw['fields']);
      const network = fields.mandate.network;
      return {
        ref: served({ kind: 'attester', network }),
        payload: { kind: 'attestation', network, fields },
      };
    }),
  );

  app.get('/v1/address', async (c) => {
    const { requestId, log, caller } = begin(c, '/v1/address');
    if (caller === null) return unauthenticated(c, log);
    const fields: { -readonly [K in keyof SignerLogFields]: SignerLogFields[K] } = { caller };
    try {
      const ref = served(parseRef(fromWire(c.req.query('ref') ?? '')));
      fields.refKind = ref.kind;
      fields.network = ref.network;
      const address = await provider.address(ref, callOptions(requestId));
      log('info', 'address_ok', { ...fields, status: 200 });
      return reply(c, 200, { address });
    } catch (error) {
      return fail(c, log, error, fields);
    }
  });

  app.get('/v1/health', async (c) => {
    const { requestId, log, caller } = begin(c, '/v1/health');
    if (caller === null) return unauthenticated(c, log);
    try {
      const health = await provider.health(callOptions(requestId));
      log('info', 'health_ok', { caller, status: 200 });
      return reply(c, 200, { health });
    } catch (error) {
      return fail(c, log, error, { caller });
    }
  });

  app.notFound((c) => reply(c, 404, { error: { code: 'NOT_FOUND' } }));
  // A throw that escaped a handler; its text never reaches the caller.
  app.onError((_error, c) => reply(c, 500, { error: { code: 'INTERNAL' } }));
  return app;
}

function unauthenticated(
  c: Context,
  log: (level: SignerLogLevel, event: string, fields: SignerLogFields) => void,
): Response {
  log('warn', 'auth_refused', { status: 401, errorCode: 'UNAUTHENTICATED' });
  return reply(c, 401, { error: { code: 'UNAUTHENTICATED' } });
}
