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
// - defineEmbedRoute: a route the widget calls with an embed token.
// - defineWebhookRoute: a provider's signed delivery, handed over as the
//   exact bytes, because parsing first would verify something else.

import {
  OPENAPI_COMPONENTS,
  PROBLEM_CODES,
  ROUTES,
  isPersonalDataSchema,
  parseQuery,
} from '@ujira/api-schema';
import type { FieldError, ProblemCode, RouteId, RouteQuery } from '@ujira/api-schema';
import { z } from 'zod';

import { API_SCOPES } from './auth.js';
import type { ApiScope, AuthenticatedMember, CallOptions, MemberRole, Tenant } from './auth.js';
import type { EmbedCaller } from './embed-auth.js';
import { ApiError, RouteRegistryError } from './errors.js';
import type { RequestLog } from './log.js';
import type { AddressLimitGroup, RateLimitGroup } from './rate-limit.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type SuccessStatus = 200 | 201 | 202;
export type DownloadContentType = 'text/csv; charset=utf-8' | 'application/pdf';

/** What a download route's handler returns. The name goes in a header, so it stays plain. */
export const FileDownload = z.strictObject({
  filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  body: z.union([z.string(), z.custom<Uint8Array>((value) => value instanceof Uint8Array)]),
});
export type FileDownload = z.infer<typeof FileDownload>;

export interface RequestContext {
  readonly requestId: string;
  /** Aborts at the request deadline. Pass it to anything that waits. */
  readonly signal: AbortSignal;
  /** Pass to every chain adapter call, so the request id travels with it. */
  readonly call: CallOptions;
  readonly log: RequestLog;
  /**
   * The client's key on a tenant write, null anywhere else. A handler that moves
   * money writes it under a unique constraint of its own, which is what stops a
   * retry paying twice if a process dies mid request.
   */
  readonly idempotencyKey: string | null;
  /** The Origin header as sent, or null. */
  readonly origin: string | null;
  /** The API key that made this call, on a tenant route. */
  readonly credentialId?: string;
  /** Who the embed token lets in, on an embed route. */
  readonly embed?: EmbedCaller;
}

export interface TenantRequestContext extends RequestContext {
  /** From the credential only. Hand it to every repository and adapter call. */
  readonly tenant: Tenant;
}

export interface MemberRequestContext extends TenantRequestContext {
  /** Who is acting, from the session only. */
  readonly member: AuthenticatedMember;
}

export interface EmbedRequestContext extends TenantRequestContext {
  readonly embed: EmbedCaller;
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
  | {
      readonly kind: 'public';
      readonly reason: string;
      /** A browser may read the answer, once the handler has accepted its origin. */
      readonly browser?: boolean;
      /** Limits by client address, since there is no key to limit by. */
      readonly addressLimit?: AddressLimitGroup;
    }
  | { readonly kind: 'embed' }
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
    /** Set when the answer is a file and not JSON. */
    readonly download?: { readonly contentType: DownloadContentType };
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
    } else if (access?.kind === 'embed') {
      if (!route.path.startsWith('/v1/embed/')) {
        problems.push(`route ${route.id} takes an embed token outside /v1/embed/`);
      }
    } else {
      problems.push(`route ${route.id} declares no access`);
    }
  }
  return problems;
}

/** Every write a tenant route takes needs an Idempotency-Key. */
export function requiresIdempotencyKey(route: Pick<Route, 'access' | 'method'>): boolean {
  return route.access.kind === 'tenant' && route.method !== 'GET';
}

// The names that say personal data whatever they hold, matching the check on the
// database's columns. `name`, `address` and `country` are not here, because they
// mean something else in this API: a mandate's name, a chain address, a corridor.
const PERSONAL_FIELD =
  /(?:^|_)(?:email|phone|msisdn|first_name|last_name|full_name|given_name|family_name|middle_name|recipient_name|account_name|birth|birthdate|dob|date_of_birth|national_id|passport|tax_id|ssn|nin|bvn|home_address|street|street_address|postal_address|postcode|zipcode|city)(?:_|$)/i;

function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// Every property in a JSON Schema, however deep, that is personal data by its name
// or by its mark.
function personalFields(schema: unknown, at: string): string[] {
  if (Array.isArray(schema)) return schema.flatMap((inner) => personalFields(inner, at));
  if (typeof schema !== 'object' || schema === null) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      for (const [name, property] of Object.entries(value as Record<string, unknown>)) {
        const path = at === '' ? name : `${at}.${name}`;
        if (PERSONAL_FIELD.test(snakeCase(name)) || isPersonalDataSchema(property)) {
          found.push(path);
        }
        found.push(...personalFields(property, path));
      }
    } else {
      found.push(...personalFields(value, at));
    }
  }
  return found;
}

/**
 * A tenant write's answer is stored in clear for 7 days so a retry can get it back,
 * and personal data has one home, encrypted. So a write route cannot be declared
 * with personal data in its response: a read route serves it instead, which is not
 * stored. The rule is on the kind of route rather than on each author's memory.
 */
export function storedResponseProblems(routes: readonly Route[]): string[] {
  return routes
    .filter((route) => requiresIdempotencyKey(route))
    .flatMap((route) =>
      personalFields(
        z.toJSONSchema(route.response.schema, { io: 'output', unrepresentable: 'any' }),
        '',
      ).map(
        (field) => `route ${route.id} stores its answer for replay, and ${field} is personal data`,
      ),
    );
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
  write: boolean,
): number[] {
  const codes: ProblemCode[] = ['INVALID_FILTER', 'INTERNAL', 'DB_UNAVAILABLE', ...extra];
  // A path id that does not parse cannot name anything.
  if (hasParams) codes.push('NOT_FOUND');
  if (access.kind === 'tenant' || access.kind === 'member') {
    codes.push('TOKEN_INVALID', 'INSUFFICIENT_SCOPE', 'RATE_LIMITED');
  }
  if (access.kind === 'embed')
    codes.push('EMBED_TOKEN_INVALID', 'ORIGIN_NOT_ALLOWED', 'RATE_LIMITED');
  if (access.kind === 'public' && access.addressLimit !== undefined) codes.push('RATE_LIMITED');
  if (hasBody) codes.push('INVALID_REQUEST', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE');
  if (write) {
    codes.push('IDEMPOTENCY_KEY_INVALID', 'IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_KEY_REUSED');
  }
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
    readonly download?: { readonly contentType: DownloadContentType };
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
      ...(spec.response.download === undefined ? {} : { download: spec.response.download }),
    }),
    errorStatuses: errorStatuses(
      access,
      Object.keys(params.shape).length > 0,
      spec.body !== undefined || rawBody !== null,
      spec.errors ?? [],
      requiresIdempotencyKey({ access, method: spec.method }),
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
 * A GET that answers with a file for the tenant of the calling key. The tenant
 * check on JSON bodies cannot read a file, so whatever builds the file has to
 * refuse another tenant's data itself.
 */
export function defineDownloadRoute<
  P extends z.ZodObject = NoInput,
  Q extends z.ZodType = NoInput,
>(spec: {
  readonly id: string;
  readonly path: `/v1/${string}`;
  readonly summary: string;
  readonly scope: ApiScope;
  readonly contentType: DownloadContentType;
  readonly params?: P;
  readonly query?: Q;
  readonly errors?: readonly ProblemCode[];
  readonly handler: (
    input: RouteInput<z.output<P>, z.output<Q>, undefined>,
    context: TenantRequestContext,
  ) => Promise<FileDownload>;
}): Route {
  return defineTenantRoute<typeof FileDownload, P, Q>({
    id: spec.id,
    method: 'GET',
    path: spec.path,
    summary: spec.summary,
    scope: spec.scope,
    ...(spec.params === undefined ? {} : { params: spec.params }),
    ...(spec.query === undefined ? {} : { query: spec.query }),
    ...(spec.errors === undefined ? {} : { errors: spec.errors }),
    response: {
      name: 'FileDownload',
      schema: FileDownload,
      download: { contentType: spec.contentType },
    },
    handler: spec.handler,
  });
}

function publicAccess(
  reason: string,
  addressLimit: AddressLimitGroup | undefined,
  browser = false,
): Access {
  return {
    kind: 'public',
    reason,
    ...(addressLimit === undefined ? {} : { addressLimit }),
    ...(browser ? { browser: true } : {}),
  };
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
    /** A browser may read the answer, once the handler has accepted its origin. */
    readonly browser?: boolean;
    readonly addressLimit?: AddressLimitGroup;
    readonly handler: (input: Input<P, Q, B>, context: RequestContext) => Promise<z.input<R>>;
  },
): Route {
  if (spec.reason.trim().length < 10) {
    throw new RouteRegistryError(`public route ${spec.id} must say why it needs no key`);
  }
  return build(
    spec,
    publicAccess(spec.reason, spec.addressLimit, spec.browser === true),
    (input, context) => spec.handler(input as Input<P, Q, B>, context),
  );
}

/**
 * A route the widget calls. Only an embed token gets in, from an origin its session
 * allows, and the handler must keep it to its own recipient.
 */
export function defineEmbedRoute<
  R extends z.ZodType,
  P extends z.ZodObject = NoInput,
  Q extends z.ZodType = NoInput,
  B extends z.ZodType = z.ZodUndefined,
>(
  spec: RouteSpec<P, Q, B, R> & {
    readonly path: `/v1/embed/${string}`;
    readonly handler: (input: Input<P, Q, B>, context: EmbedRequestContext) => Promise<z.input<R>>;
  },
): Route {
  return build(spec, { kind: 'embed' }, (input, context, tenant) => {
    // The pipeline authenticates first, so a gap here is its bug, and it fails closed.
    const { embed } = context;
    if (tenant === null || embed === undefined) return Promise.reject(new ApiError('INTERNAL'));
    return spec.handler(input as Input<P, Q, B>, { ...context, tenant, embed });
  });
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
  readonly addressLimit?: AddressLimitGroup;
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
    publicAccess(spec.reason, spec.addressLimit),
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
