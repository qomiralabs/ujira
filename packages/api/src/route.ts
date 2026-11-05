// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// How an endpoint is declared. A route is data (method, path, schemas, the
// scope it needs) plus one handler, and the pipeline in app.ts does
// everything else: authentication, validation, the deadline, response
// checks, errors and logs. Handlers stay small and cannot skip a step.
//
// There are five ways in:
// - contractRoute: a read route already described in @ujira/api-schema;
//   its path, schemas and query rules come from there.
// - defineTenantRoute: any other route that acts for a tenant.
// - defineMemberRoute: an action a person takes in the dashboard, which no key
//   can reach.
// - definePublicRoute: a route with no tenant, which must say why.
// - defineWebhookRoute: a provider's signed delivery, handed over as the
//   exact bytes, because parsing first would verify something else.

import { OPENAPI_COMPONENTS, PROBLEM_CODES, ROUTES, parseQuery } from '@ujira/api-schema';
import type { FieldError, ProblemCode, RouteId, RouteQuery } from '@ujira/api-schema';
import { z } from 'zod';

import { API_SCOPES } from './auth.js';
import type { ApiScope, AuthenticatedMember, CallOptions, MemberRole, Tenant } from './auth.js';
import { ApiError, RouteRegistryError } from './errors.js';
import type { RequestLog } from './log.js';
import type { RateLimitGroup } from './rate-limit.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type SuccessStatus = 200 | 201 | 202;

export interface RequestContext {
  readonly requestId: string;
  /** Aborts at the request deadline. Pass it to anything that waits. */
  readonly signal: AbortSignal;
  /** Pass to every chain adapter call, so the request id travels with it. */
  readonly call: CallOptions;
  readonly log: RequestLog;
}

export interface TenantRequestContext extends RequestContext {
  /** From the credential only. Hand it to every repository and adapter call. */
  readonly tenant: Tenant;
}

export interface MemberRequestContext extends TenantRequestContext {
  /** Who is acting, from the session only. */
  readonly member: AuthenticatedMember;
}

export interface RouteInput<P, Q, B> {
  readonly params: P;
  readonly query: Q;
  readonly body: B;
}

export type QueryParse =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly code: ProblemCode; readonly errors: readonly FieldError[] };

export type Access =
  | { readonly kind: 'public'; readonly reason: string }
  | {
      readonly kind: 'tenant';
      readonly scope: ApiScope;
      /** A tighter limit on top of the ones every tenant route has. */
      readonly rateLimit?: RateLimitGroup;
    }
  | {
      readonly kind: 'member';
      /** Who may take this action. Never empty. */
      readonly roles: readonly MemberRole[];
      /** True: this needs a second factor passed within the last five minutes. */
      readonly stepUp: boolean;
    };

/** A route as the pipeline sees it, with its types erased. */
export interface Route {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly access: Access;
  readonly params: z.ZodObject;
  readonly query: z.ZodType;
  readonly parseQuery: (search: URLSearchParams) => QueryParse;
  readonly body: z.ZodType | null;
  /** Set on a webhook route: the body stays bytes, and only these headers are passed on. */
  readonly rawBody: { readonly headers: readonly string[] } | null;
  readonly response: {
    readonly status: SuccessStatus;
    readonly name: string;
    readonly schema: z.ZodType;
  };
  /** Statuses this route can answer with besides its success status. */
  readonly errorStatuses: readonly number[];
  /** tenant is null exactly when access is public, and member set exactly on a member route. */
  readonly handle: (
    input: RouteInput<unknown, unknown, unknown>,
    context: RequestContext,
    tenant: Tenant | null,
    member?: AuthenticatedMember | null,
  ) => Promise<unknown>;
}

/** What a webhook handler gets instead of a parsed body. */
export interface WebhookInput {
  /** The body exactly as sent, unparsed. */
  readonly rawBody: Uint8Array;
  /** Only the headers the route declared, by lower case name. */
  readonly headers: Readonly<Record<string, string | undefined>>;
}

const KNOWN_SCOPES: ReadonlySet<string> = new Set(API_SCOPES);

/**
 * Everything wrong with how these routes declare who may call them. The
 * definers require all of it, but a route can be built as a plain object, and a
 * route with no scope must not get as far as serving.
 */
export function routeAccessProblems(routes: readonly Route[]): string[] {
  const problems: string[] = [];
  for (const route of routes) {
    const access = route.access as Access | undefined;
    if (access?.kind === 'tenant') {
      if (!KNOWN_SCOPES.has(access.scope)) {
        problems.push(`route ${route.id} has no scope from the closed list`);
      }
    } else if (access?.kind === 'member') {
      if (access.roles.length === 0) problems.push(`route ${route.id} allows no role`);
    } else if (access?.kind === 'public') {
      if (access.reason.trim().length < 10) {
        problems.push(`route ${route.id} must say why it needs no key`);
      }
    } else {
      problems.push(`route ${route.id} declares no access`);
    }
  }
  return problems;
}

const NoInput = z.strictObject({});
type NoInput = typeof NoInput;

// Field errors from a zod failure, with paths only. The unknown key a client
// sent is echoed as the field name, so it is cut to what the problem body
// allows.
export function fieldErrors(issues: readonly z.core.$ZodIssue[]): FieldError[] {
  const errors: FieldError[] = [];
  for (const issue of issues) {
    const base = issue.path.map(String).join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const field = base === '' ? key : `${base}.${key}`;
        errors.push({ field: field.slice(0, 200) || '(empty)', code: 'unknown_field' });
      }
    } else {
      errors.push({ field: base.slice(0, 200) || '(root)', code: 'invalid_value' });
    }
  }
  return errors.slice(0, 50);
}

/** Query parsing for routes outside the contract: a repeated key is refused. */
export function queryParser(schema: z.ZodType): (search: URLSearchParams) => QueryParse {
  return (search) => {
    const record: Record<string, string> = {};
    const errors: FieldError[] = [];
    for (const [key, value] of search.entries()) {
      if (Object.hasOwn(record, key))
        errors.push({ field: key.slice(0, 200), code: 'repeated_key' });
      record[key] = value;
    }
    const parsed = schema.safeParse(record);
    if (parsed.success && errors.length === 0) return { success: true, data: parsed.data };
    errors.push(...fieldErrors(parsed.error?.issues ?? []));
    return { success: false, code: 'INVALID_FILTER', errors: errors.slice(0, 50) };
  };
}

// The pipeline authenticates before it calls a tenant route, so a missing
// tenant here is a bug in the pipeline, and it fails closed.
function asTenant<T>(
  context: RequestContext,
  tenant: Tenant | null,
  run: (context: TenantRequestContext) => Promise<T>,
): Promise<T> {
  if (tenant === null) return Promise.reject(new ApiError('INTERNAL'));
  return run({ ...context, tenant });
}

function statusesOf(codes: readonly ProblemCode[]): number[] {
  return codes.map((code) => PROBLEM_CODES[code]);
}

// What the pipeline itself can answer on any route of a kind, so a route
// only lists what its handler adds.
function errorStatuses(
  access: Access,
  hasParams: boolean,
  hasBody: boolean,
  extra: readonly ProblemCode[],
): number[] {
  const codes: ProblemCode[] = ['INVALID_FILTER', 'INTERNAL', 'DB_UNAVAILABLE', ...extra];
  // A path id that does not parse cannot name anything.
  if (hasParams) codes.push('NOT_FOUND');
  if (access.kind === 'tenant' || access.kind === 'member') {
    codes.push('TOKEN_INVALID', 'INSUFFICIENT_SCOPE', 'RATE_LIMITED');
  }
  if (hasBody) codes.push('INVALID_REQUEST', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE');
  return [...new Set(statusesOf(codes))].sort((a, b) => a - b);
}

interface RouteSpec<
  P extends z.ZodObject,
  Q extends z.ZodType,
  B extends z.ZodType,
  R extends z.ZodType,
> {
  /** The OpenAPI operationId, unique across the API. */
  readonly id: string;
  readonly method: HttpMethod;
  /** OpenAPI style, with {name} for path parameters, under /v1/. */
  readonly path: `/v1/${string}`;
  readonly summary: string;
  readonly params?: P;
  readonly query?: Q;
  /** A JSON body. Leave it out for a route that takes none. */
  readonly body?: B;
  readonly response: {
    readonly status?: SuccessStatus;
    /** The OpenAPI component name of the success body. */
    readonly name: string;
    readonly schema: R;
  };
  /** Codes the handler itself throws, such as NOT_FOUND. */
  readonly errors?: readonly ProblemCode[];
}

type Input<P extends z.ZodObject, Q extends z.ZodType, B extends z.ZodType> = RouteInput<
  z.output<P>,
  z.output<Q>,
  z.output<B>
>;

function build<
  P extends z.ZodObject,
  Q extends z.ZodType,
  B extends z.ZodType,
  R extends z.ZodType,
>(
  spec: RouteSpec<P, Q, B, R>,
  access: Access,
  handle: Route['handle'],
  rawBody: Route['rawBody'] = null,
): Route {
  const query = spec.query ?? NoInput;
  const params = spec.params ?? NoInput;
  return Object.freeze({
    id: spec.id,
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    access,
    params,
    query,
    parseQuery: queryParser(query),
    body: spec.body ?? null,
    rawBody,
    response: Object.freeze({
      status: spec.response.status ?? 200,
      name: spec.response.name,
      schema: spec.response.schema,
    }),
    errorStatuses: errorStatuses(
      access,
      Object.keys(params.shape).length > 0,
      spec.body !== undefined || rawBody !== null,
      spec.errors ?? [],
    ),
    handle,
  });
}

/** A route that acts for the tenant of the calling key, which must hold `scope`. */
export function defineTenantRoute<
  R extends z.ZodType,
  P extends z.ZodObject = NoInput,
  Q extends z.ZodType = NoInput,
  B extends z.ZodType = z.ZodUndefined,
>(
  spec: RouteSpec<P, Q, B, R> & {
    readonly scope: ApiScope;
    readonly rateLimit?: RateLimitGroup;
    readonly handler: (input: Input<P, Q, B>, context: TenantRequestContext) => Promise<z.input<R>>;
  },
): Route {
  const access: Access = {
    kind: 'tenant',
    scope: spec.scope,
    ...(spec.rateLimit === undefined ? {} : { rateLimit: spec.rateLimit }),
  };
  return build(spec, access, (input, context, tenant) =>
    asTenant(context, tenant, (scoped) => spec.handler(input as Input<P, Q, B>, scoped)),
  );
}

/**
 * An action a person takes in the dashboard. The pipeline refuses an API key by
 * its form before anything else, so a key cannot reach this however it is scoped,
 * and then checks the role and how fresh the second factor is.
 */
export function defineMemberRoute<
  R extends z.ZodType,
  P extends z.ZodObject = NoInput,
  Q extends z.ZodType = NoInput,
  B extends z.ZodType = z.ZodUndefined,
>(
  spec: RouteSpec<P, Q, B, R> & {
    readonly roles: readonly MemberRole[];
    readonly stepUp: boolean;
    readonly handler: (input: Input<P, Q, B>, context: MemberRequestContext) => Promise<z.input<R>>;
  },
): Route {
  if (spec.roles.length === 0) throw new RouteRegistryError(`route ${spec.id} allows no role`);
  const access: Access = { kind: 'member', roles: spec.roles, stepUp: spec.stepUp };
  return build(spec, access, (input, context, tenant, member) => {
    // The pipeline authenticates first, so this is a bug in it, and it fails closed.
    if (tenant === null || member === undefined || member === null) {
      return Promise.reject(new ApiError('INTERNAL'));
    }
    return spec.handler(input as Input<P, Q, B>, { ...context, tenant, member });
  });
}

/**
 * A route with no tenant. It gets no tenant in its context and must return
 * no tenant data; `reason` says why it needs no key, for the reviewer.
 */
export function definePublicRoute<
  R extends z.ZodType,
  P extends z.ZodObject = NoInput,
  Q extends z.ZodType = NoInput,
  B extends z.ZodType = z.ZodUndefined,
>(
  spec: RouteSpec<P, Q, B, R> & {
    readonly reason: string;
    readonly handler: (input: Input<P, Q, B>, context: RequestContext) => Promise<z.input<R>>;
  },
): Route {
  if (spec.reason.trim().length < 10) {
    throw new RouteRegistryError(`public route ${spec.id} must say why it needs no key`);
  }
  return build(spec, { kind: 'public', reason: spec.reason }, (input, context) =>
    spec.handler(input as Input<P, Q, B>, context),
  );
}

const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

/**
 * A provider's signed delivery, with no key and no tenant. The handler gets
 * the exact bytes and the headers it names, and nothing else of the request:
 * it must verify the signature before it believes any of it. `reason` says
 * what stands in for a key, for the reviewer.
 */
export function defineWebhookRoute<R extends z.ZodType>(spec: {
  readonly id: string;
  readonly path: `/v1/${string}`;
  readonly summary: string;
  readonly reason: string;
  /** The headers the signature check needs, by lower case name. */
  readonly headers: readonly string[];
  readonly response: { readonly name: string; readonly schema: R };
  readonly errors?: readonly ProblemCode[];
  readonly handler: (input: WebhookInput, context: RequestContext) => Promise<z.input<R>>;
}): Route {
  if (spec.reason.trim().length < 10) {
    throw new RouteRegistryError(`webhook route ${spec.id} must say what stands in for a key`);
  }
  if (spec.headers.length === 0 || !spec.headers.every((name) => HEADER_NAME.test(name))) {
    throw new RouteRegistryError(`webhook route ${spec.id} must name its headers in lower case`);
  }
  return build(
    {
      id: spec.id,
      method: 'POST',
      path: spec.path,
      summary: spec.summary,
      response: spec.response,
      ...(spec.errors === undefined ? {} : { errors: spec.errors }),
    },
    { kind: 'public', reason: spec.reason },
    (input, context) => spec.handler(input.body as WebhookInput, context),
    Object.freeze({ headers: Object.freeze([...spec.headers]) }),
  );
}

function componentName(schema: z.ZodType, id: string): string {
  const found = OPENAPI_COMPONENTS.find(([, candidate]) => candidate === schema);
  if (found === undefined) {
    throw new RouteRegistryError(`contract route ${id} has a response that is not a component`);
  }
  return found[0];
}

type ContractParams<I extends RouteId> = z.output<(typeof ROUTES)[I]['params']>;
type ContractResponse<I extends RouteId> = z.input<(typeof ROUTES)[I]['response']>;

/**
 * A read route described in @ujira/api-schema. Method, path, summary,
 * schemas, query rules and error statuses all come from the contract, so the
 * API, the mocks and the dashboard cannot disagree about it.
 */
export function contractRoute<I extends RouteId>(
  id: I,
  spec: {
    readonly scope: ApiScope;
    readonly handler: (
      input: RouteInput<ContractParams<I>, RouteQuery<I>, undefined>,
      context: TenantRequestContext,
    ) => Promise<ContractResponse<I>>;
  },
): Route {
  const contract = ROUTES[id];
  return Object.freeze({
    id,
    method: contract.method,
    path: contract.path,
    summary: contract.summary,
    access: { kind: 'tenant', scope: spec.scope },
    params: contract.params,
    query: contract.query,
    parseQuery: (search: URLSearchParams) => parseQuery(id, search),
    body: null,
    rawBody: null,
    response: Object.freeze({
      status: 200,
      name: componentName(contract.response, id),
      schema: contract.response,
    }),
    errorStatuses: [...contract.errors],
    handle: (input, context, tenant) =>
      asTenant(context, tenant, (scoped) =>
        spec.handler(input as RouteInput<ContractParams<I>, RouteQuery<I>, undefined>, scoped),
      ),
  } satisfies Route);
}
