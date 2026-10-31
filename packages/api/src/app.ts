// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The request pipeline every route shares. In order, for each request:
//
// 1. a request id, sent back in Request-Id and used as the correlation id
//    of every call the handler makes;
// 2. a deadline, as an AbortSignal the handler passes on;
// 3. for a tenant route, the credential, then the route's scope;
// 4. path, query and body, each validated by the route's zod schema;
// 5. the handler;
// 6. the response, validated by its schema, and for a tenant route checked
//    for any principal or project that is not the caller's;
// 7. one access log line, with no request data in it.
//
// Every failure on the way becomes a problem body with a stable code, from
// errors.ts. Nothing is swallowed: an error that maps to INTERNAL is logged
// by class name before the client gets its 500.

import { randomBytes } from 'node:crypto';

import { buildProblem } from '@ujira/api-schema';
import { Hono } from 'hono';
import type { Context } from 'hono';

import { AuthenticatedTenantSchema } from './auth.js';
import type { Authenticate, CallOptions, Tenant } from './auth.js';
import { readJsonBody } from './body.js';
import { ApiError, RouteRegistryError, toApiError } from './errors.js';
import { errorNameOf, requestLog } from './log.js';
import type { Logger, RequestLog } from './log.js';
import { withOpenApiRoute } from './openapi.js';
import { fieldErrors } from './route.js';
import type { Route } from './route.js';
import { foreignTenantPath } from './tenant-guard.js';

export const API_DEFAULTS = Object.freeze({
  requestTimeoutMs: 10_000,
  bodyLimitBytes: 1_048_576,
});

export interface ApiDependencies {
  readonly routes: readonly Route[];
  readonly authenticate: Authenticate;
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

function respond(
  body: unknown,
  status: number,
  requestId: string,
  type: 'application/json' | 'application/problem+json',
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
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
  });
  const headers =
    error.retryAfterSeconds === null
      ? extra
      : { ...extra, 'retry-after': String(error.retryAfterSeconds) };
  return respond(body, error.status, requestId, 'application/problem+json', headers);
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
    let outcome: Outcome;
    try {
      const response = await underDeadline(
        controller.signal,
        async () => {
          if (route.access.kind === 'tenant') {
            tenant = await authenticateRequest(deps.authenticate, c.req.raw, call, route, log);
          }
          const params = route.params.safeParse(c.req.param());
          // A malformed id cannot name anything, so it reads as not found.
          if (!params.success) throw new ApiError('NOT_FOUND');
          const query = route.parseQuery(new URL(c.req.url).searchParams);
          if (!query.success) throw new ApiError(query.code, { errors: query.errors });
          let body: unknown = undefined;
          if (route.body !== null) {
            const parsed = route.body.safeParse(await readJsonBody(c.req.raw, bodyLimit));
            if (!parsed.success) {
              throw new ApiError('INVALID_REQUEST', { errors: fieldErrors(parsed.error.issues) });
            }
            body = parsed.data;
          }
          const result = await route.handle(
            { params: params.data, query: query.data, body },
            { requestId, signal: controller.signal, call, log },
            tenant,
          );
          return checkedResponse(route, result, tenant, requestId, log);
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

async function authenticateRequest(
  authenticate: Authenticate,
  request: Request,
  call: CallOptions,
  route: Route,
  log: RequestLog,
): Promise<Tenant> {
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
  const { principalId, projectId, scopes } = checked.data;
  if (route.access.kind === 'tenant' && !scopes.includes(route.access.scope)) {
    throw new ApiError('INSUFFICIENT_SCOPE', {
      detail: `This route needs the ${route.access.scope} scope`,
    });
  }
  return { principalId, projectId };
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
