// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The request pipeline every route shares. In order, for each request:
//
// 1. a request id, sent back in Request-Id and used as the correlation id
//    of every call the handler makes;
// 2. a deadline, as an AbortSignal the handler passes on;
// 3. for a tenant route, the credential, the rate limits, then the route's
//    scope, so a request that will be refused its scope still counts;
// 4. path, query and body, each validated by the route's zod schema, except
//    that a webhook route gets its body as the bytes that were sent;
// 5. for a tenant write, the Idempotency-Key, which may answer from what is
//    stored instead of running the handler;
// 6. the handler;
// 7. the response, validated by its schema, and for a tenant route checked
//    for any principal or project that is not the caller's;
// 8. one access log line, with no request data in it.
//
// Every failure on the way becomes a problem body with a stable code, from
// errors.ts. Nothing is swallowed: an error that maps to INTERNAL is logged
// by class name before the client gets its 500.

import { randomBytes } from 'node:crypto';

import { buildProblem } from '@ujira/api-schema';
import { Hono } from 'hono';
import type { Context } from 'hono';

import { AuthenticatedTenantSchema } from './auth.js';
import type { AuthenticatedTenant, Authenticate, CallOptions, Tenant } from './auth.js';
import { parseJsonBody, readRawBody } from './body.js';
import { ApiError, RouteRegistryError, toApiError } from './errors.js';
import {
  IDEMPOTENCY_LEASE_SECONDS,
  idempotencyKeyOf,
  isFinalStatus,
  requestFingerprint,
} from './idempotency.js';
import type { IdempotencyStore, Reservation } from './idempotency.js';
import { errorNameOf, requestLog } from './log.js';
import type { Logger, RequestLog } from './log.js';
import { withOpenApiRoute } from './openapi.js';
import { rateLimitHeaders } from './rate-limit.js';
import type { RateLimit } from './rate-limit.js';
import {
  fieldErrors,
  requiresIdempotencyKey,
  routeAccessProblems,
  storedResponseProblems,
} from './route.js';
import type { Route, WebhookInput } from './route.js';
import { foreignTenantPath } from './tenant-guard.js';

export const API_DEFAULTS = Object.freeze({
  requestTimeoutMs: 10_000,
  bodyLimitBytes: 1_048_576,
});

export interface ApiDependencies {
  readonly routes: readonly Route[];
  readonly authenticate: Authenticate;
  /** Required, so a server cannot be built that forgot its limits. */
  readonly rateLimit: RateLimit;
  /** Required, so a server cannot be built whose writes have no replay protection. */
  readonly idempotency: IdempotencyStore;
  readonly logger: Logger;
  readonly requestTimeoutMs?: number;
  readonly bodyLimitBytes?: number;
  /** Replaceable for tests; must return text matching the Problem requestId rule. */
  readonly newRequestId?: () => string;
  readonly now?: () => Date;
}

/** 18 random bytes as base64url: 24 characters, safe in a header and a log. */
export function newRequestId(): string {
  return `req_${randomBytes(18).toString('base64url')}`;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

// Headers on every response. The API serves JSON to programs, so nothing is
// cached, nothing is sniffed and no CORS header is ever sent.
const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

type BodyType = 'application/json' | 'application/problem+json';

function respond(
  body: unknown,
  status: number,
  requestId: string,
  type: BodyType,
  extra: Record<string, string> = {},
): Response {
  return respondText(JSON.stringify(body), status, requestId, type, extra);
}

function respondText(
  text: string,
  status: number,
  requestId: string,
  type: BodyType,
  extra: Record<string, string> = {},
): Response {
  return new Response(text, {
    status,
    headers: {
      ...BASE_HEADERS,
      ...extra,
      'content-type': `${type}; charset=utf-8`,
      'request-id': requestId,
    },
  });
}

function problemResponse(error: ApiError, requestId: string, extra: Record<string, string> = {}) {
  const body = buildProblem(error.code, requestId, {
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    errors: error.errors,
    fixes: error.fixes,
  });
  const headers =
    error.retryAfterSeconds === null
      ? extra
      : { ...extra, 'retry-after': String(error.retryAfterSeconds) };
  return respond(body, error.status, requestId, 'application/problem+json', headers);
}

// Only what the route named, so a credential or a cookie sent to a webhook
// never reaches its handler.
function namedHeaders(
  headers: Headers,
  names: readonly string[],
): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, headers.get(name) ?? undefined]));
}

function honoPath(path: string): string {
  return path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
}

function pathPattern(path: string): RegExp {
  const escaped = path
    .split(/\{[A-Za-z0-9_]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${escaped}$`);
}

function checkRegistry(routes: readonly Route[]): void {
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  for (const route of routes) {
    if (!route.path.startsWith('/v1/')) {
      throw new RouteRegistryError(`route ${route.id} is not under /v1/`);
    }
    if (ids.has(route.id)) throw new RouteRegistryError(`route id ${route.id} is used twice`);
    const endpoint = `${route.method} ${route.path}`;
    if (endpoints.has(endpoint)) throw new RouteRegistryError(`${endpoint} is declared twice`);
    ids.add(route.id);
    endpoints.add(endpoint);
  }
}

// Runs the work under the deadline. The work is not cancelled by the race,
// only answered for; it sees the abort through its signal. If it fails after
// the client already got its 503, that failure is still logged.
async function underDeadline<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
  log: RequestLog,
): Promise<T> {
  const running = work();
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new ApiError('REQUEST_TIMEOUT'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([running, deadline]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    if (signal.aborted) {
      running.catch((error: unknown) => {
        log.warn('late_failure', { errorName: errorNameOf(error) });
      });
    }
  }
}

interface Outcome {
  readonly response: Response;
  readonly tenant: Tenant | null;
  readonly errorCode?: string;
}

/** Builds the API. The OpenAPI route is added to the routes given. */
export function createApp(deps: ApiDependencies): Hono {
  // Before the document is built, which reads what each route declares.
  const [accessProblem] = routeAccessProblems(deps.routes);
  if (accessProblem !== undefined) throw new RouteRegistryError(accessProblem);
  const [storedProblem] = storedResponseProblems(deps.routes);
  if (storedProblem !== undefined) throw new RouteRegistryError(storedProblem);
  const { routes } = withOpenApiRoute(deps.routes);
  checkRegistry(routes);
  const timeoutMs = deps.requestTimeoutMs ?? API_DEFAULTS.requestTimeoutMs;
  const bodyLimit = deps.bodyLimitBytes ?? API_DEFAULTS.bodyLimitBytes;
  const nextId = deps.newRequestId ?? newRequestId;
  const now = deps.now ?? (() => new Date());
  const patterns = routes.map((route) => ({ route, pattern: pathPattern(route.path) }));

  const startRequest = (): { requestId: string; log: RequestLog; started: number } => {
    const candidate = nextId();
    // A bad generator is a bug; the response still needs a valid id.
    const requestId = REQUEST_ID.test(candidate) ? candidate : newRequestId();
    return { requestId, log: requestLog(deps.logger, requestId, now), started: now().getTime() };
  };

  const accessLog = (
    log: RequestLog,
    started: number,
    method: string,
    route: string,
    outcome: Outcome,
  ): void => {
    log.info('request', {
      method,
      route,
      status: outcome.response.status,
      durationMs: now().getTime() - started,
      ...(outcome.tenant === null
        ? {}
        : { principalId: outcome.tenant.principalId, projectId: outcome.tenant.projectId }),
      ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
    });
  };

  const failure = (error: unknown, log: RequestLog): ApiError => {
    const mapped = toApiError(error);
    if (mapped.status >= 500 && !(error instanceof ApiError)) {
      log.error('request_failed', { errorName: errorNameOf(error), errorCode: mapped.code });
    }
    return mapped;
  };

  const run = async (route: Route, c: Context): Promise<Response> => {
    const { requestId, log, started } = startRequest();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    const call: CallOptions = { signal: controller.signal, correlationId: requestId };
    let tenant: Tenant | null = null;
    let limitHeaders: Record<string, string> = {};
    let outcome: Outcome;
    try {
      const response = await underDeadline(
        controller.signal,
        async () => {
          if (route.access.kind === 'tenant') {
            const caller = await authenticateRequest(deps.authenticate, c.req.raw, call, log);
            tenant = { principalId: caller.principalId, projectId: caller.projectId };
            const decision = await deps.rateLimit(
              { tenant, tokenId: caller.tokenId, group: route.access.rateLimit ?? null },
              call,
            );
            limitHeaders = rateLimitHeaders(decision);
            if (!decision.allowed) {
              throw new ApiError('RATE_LIMITED', {
                retryAfterSeconds: decision.retryAfterSeconds,
              });
            }
            if (!caller.scopes.includes(route.access.scope)) {
              throw new ApiError('INSUFFICIENT_SCOPE', {
                detail: `This route needs the ${route.access.scope} scope`,
              });
            }
          }
          const idempotencyKey = requiresIdempotencyKey(route)
            ? idempotencyKeyOf(c.req.raw.headers)
            : null;
          const params = route.params.safeParse(c.req.param());
          // A malformed id cannot name anything, so it reads as not found.
          if (!params.success) throw new ApiError('NOT_FOUND');
          const query = route.parseQuery(new URL(c.req.url).searchParams);
          if (!query.success) throw new ApiError(query.code, { errors: query.errors });
          let body: unknown = undefined;
          let bodyBytes: Uint8Array | null = null;
          if (route.rawBody !== null) {
            const input: WebhookInput = {
              rawBody: await readRawBody(c.req.raw, bodyLimit),
              headers: namedHeaders(c.req.raw.headers, route.rawBody.headers),
            };
            body = input;
          } else if (route.body !== null) {
            bodyBytes = await readRawBody(c.req.raw, bodyLimit);
            const parsed = route.body.safeParse(parseJsonBody(bodyBytes));
            if (!parsed.success) {
              throw new ApiError('INVALID_REQUEST', { errors: fieldErrors(parsed.error.issues) });
            }
            body = parsed.data;
          }
          const answer = async (): Promise<Response> => {
            const result = await route.handle(
              { params: params.data, query: query.data, body },
              { requestId, signal: controller.signal, call, log, idempotencyKey },
              tenant,
            );
            return checkedResponse(route, result, tenant, requestId, log);
          };
          if (idempotencyKey === null || tenant === null) return answer();
          return answerOnce(
            {
              store: deps.idempotency,
              tenant,
              key: idempotencyKey,
              requestSha256: requestFingerprint(route.method, new URL(c.req.url), bodyBytes),
              requestId,
              call,
              log,
            },
            answer,
          );
        },
        log,
      );
      outcome = { response, tenant };
    } catch (error) {
      const apiError = failure(error, log);
      outcome = {
        response: problemResponse(apiError, requestId),
        tenant,
        errorCode: apiError.code,
      };
    } finally {
      clearTimeout(timer);
    }
    for (const [name, value] of Object.entries(limitHeaders)) {
      outcome.response.headers.set(name, value);
    }
    accessLog(log, started, route.method, route.path, outcome);
    return outcome.response;
  };

  const app = new Hono();
  for (const route of routes) {
    app.on(route.method, honoPath(route.path), (c) => run(route, c));
  }

  // No route matched. A path that exists under another method is a 405
  // with Allow, so a client learns it used the wrong verb, not a wrong URL.
  app.notFound((c) => {
    const { requestId, log, started } = startRequest();
    const path = new URL(c.req.url).pathname;
    const allowed = patterns
      .filter(({ pattern }) => pattern.test(path))
      .map(({ route }) => route.method);
    const response =
      allowed.length === 0
        ? problemResponse(new ApiError('NOT_FOUND'), requestId)
        : problemResponse(new ApiError('METHOD_NOT_ALLOWED'), requestId, {
            allow: [...new Set(allowed)].sort().join(', '),
          });
    const errorCode = allowed.length === 0 ? 'NOT_FOUND' : 'METHOD_NOT_ALLOWED';
    accessLog(log, started, c.req.method, 'unmatched', { response, tenant: null, errorCode });
    return response;
  });

  // The pipeline catches everything it runs, so this is only reached by a
  // failure in the framework itself. It still answers with the model.
  app.onError((error) => {
    const { requestId, log } = startRequest();
    return problemResponse(failure(error, log), requestId);
  });

  return app;
}

interface OnceRequest {
  readonly store: IdempotencyStore;
  readonly tenant: Tenant;
  readonly key: string;
  readonly requestSha256: Buffer;
  readonly requestId: string;
  readonly call: CallOptions;
  readonly log: RequestLog;
}

function replayed(stored: Extract<Reservation, { kind: 'replay' }>): Response {
  return respondText(
    stored.body,
    stored.status,
    stored.requestId,
    stored.status >= 400 ? 'application/problem+json' : 'application/json',
    { 'idempotent-replayed': 'true' },
  );
}

// Runs the handler if this attempt wins the key. This runs inside the request's
// deadline race, so a handler that outlives the deadline still finishes here and
// stores its answer, and until then a retry finds the key running rather than
// starting it a second time.
async function answerOnce(
  request: OnceRequest,
  answer: () => Promise<Response>,
): Promise<Response> {
  const { store, tenant, key, requestSha256, requestId, call, log } = request;
  const reservation = await store.reserve(
    tenant,
    { key, requestSha256, leaseSeconds: IDEMPOTENCY_LEASE_SECONDS },
    call,
  );
  switch (reservation.kind) {
    case 'mismatch':
      throw new ApiError('IDEMPOTENCY_KEY_REUSED');
    case 'in_progress':
      throw new ApiError('IDEMPOTENCY_IN_PROGRESS');
    case 'replay':
      log.info('idempotent_replay', { resourceId: reservation.requestId });
      return replayed(reservation);
    case 'started':
      break;
  }
  const { leaseId } = reservation;

  // The handler's own outcome is what the client gets, so neither of these may
  // replace it. If the answer cannot be stored the key stays leased, and a retry
  // runs the handler again once the lease is out, which is why a handler that moves
  // money needs a unique constraint of its own.
  const finish = async (response: Response): Promise<void> => {
    try {
      const body = await response.clone().text();
      const stored = await store.complete(
        tenant,
        { key, leaseId, status: response.status, requestId, body },
        call,
      );
      if (!stored) log.warn('idempotency_lease_lost', { ...tenant });
    } catch (error) {
      log.error('idempotency_complete_failed', { ...tenant, errorName: errorNameOf(error) });
    }
  };
  const giveBack = async (): Promise<void> => {
    try {
      await store.release(tenant, { key, leaseId }, call);
    } catch (error) {
      log.error('idempotency_release_failed', { ...tenant, errorName: errorNameOf(error) });
    }
  };

  let response: Response;
  try {
    response = await answer();
  } catch (error) {
    const mapped = toApiError(error);
    if (isFinalStatus(mapped.status)) await finish(problemResponse(mapped, requestId));
    else await giveBack();
    throw error;
  }
  await finish(response);
  return response;
}

async function authenticateRequest(
  authenticate: Authenticate,
  request: Request,
  call: CallOptions,
  log: RequestLog,
): Promise<AuthenticatedTenant> {
  const result = await authenticate(
    {
      authorization: request.headers.get('authorization'),
      origin: request.headers.get('origin'),
    },
    call,
  );
  if (!result.ok) throw new ApiError(result.code);
  // The authenticator is ours, but what it returns becomes the tenant of
  // every query, so it is checked like input.
  const checked = AuthenticatedTenantSchema.safeParse(result.tenant);
  if (!checked.success) {
    log.error('authenticator_contract_violation', {
      issues: checked.error.issues.map((issue) => issue.path.join('.')),
    });
    throw new ApiError('INTERNAL');
  }
  return checked.data;
}

function checkedResponse(
  route: Route,
  result: unknown,
  tenant: Tenant | null,
  requestId: string,
  log: RequestLog,
): Response {
  const parsed = route.response.schema.safeParse(result);
  if (!parsed.success) {
    // A handler that breaks its own contract is a bug; the client gets a
    // 500 rather than a body the documentation does not describe.
    log.error('response_contract_violation', {
      route: route.path,
      issues: parsed.error.issues.slice(0, 20).map((issue) => issue.path.join('.')),
    });
    throw new ApiError('INTERNAL');
  }
  if (tenant !== null) {
    const foreign = foreignTenantPath(parsed.data, tenant);
    if (foreign !== null) {
      log.error('tenant_leak_blocked', { route: route.path, issues: [foreign] });
      throw new ApiError('INTERNAL');
    }
  }
  return respond(parsed.data, route.response.status, requestId, 'application/json');
}
