// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { z } from 'zod';

import { PROBLEM_CODES, PROBLEM_TYPE_BASE, Problem } from './envelope.js';
import type { ProblemCode } from './envelope.js';
import { ContractMismatchError, UnknownRouteError } from './errors.js';
import type { ContractIssue } from './errors.js';
import { ROUTES } from './routes.js';
import type { RouteId, RouteQuery, RouteResponse } from './routes.js';

const TITLES: Readonly<Record<ProblemCode, string>> = Object.freeze({
  INVALID_FILTER: 'The filter is not valid',
  INVALID_CURSOR: 'The cursor is not valid for this list',
  LIMIT_OUT_OF_RANGE: 'The limit must be from 1 to 200',
  INVALID_AMOUNT: 'The amount is not an integer count of minor units',
  TOKEN_MALFORMED: 'The API key is missing or malformed',
  TOKEN_INVALID: 'The API key is not valid',
  TOKEN_ENVIRONMENT_MISMATCH: 'The API key is for another environment',
  EMBED_TOKEN_INVALID: 'The embed session is not valid',
  INSUFFICIENT_SCOPE: 'The API key lacks the scope this route needs',
  ORIGIN_NOT_ALLOWED: 'The request origin is not allowed',
  EMBED_SCOPE_VIOLATION: 'The embed session cannot reach this route',
  NOT_FOUND: 'Not found',
  RATE_LIMITED: 'Too many requests',
});

export interface FieldError {
  readonly field: string;
  readonly code: 'unknown_field' | 'invalid_value' | 'unsupported_operator' | 'range_inverted';
}

/** A problem body that always passes its own schema. */
export function buildProblem(
  code: ProblemCode,
  requestId: string,
  extra: { readonly detail?: string; readonly errors?: readonly FieldError[] } = {},
): Problem {
  return {
    type: `${PROBLEM_TYPE_BASE}${code}`,
    title: TITLES[code],
    status: PROBLEM_CODES[code],
    code,
    requestId,
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    ...(extra.errors === undefined || extra.errors.length === 0
      ? {}
      : { errors: [...extra.errors] }),
  };
}

export type QueryResult<R extends RouteId> =
  | { readonly success: true; readonly data: RouteQuery<R> }
  | { readonly success: false; readonly code: ProblemCode; readonly errors: readonly FieldError[] };

function routeOf(route: string): (typeof ROUTES)[RouteId] {
  if (!Object.hasOwn(ROUTES, route)) throw new UnknownRouteError(`no route named ${route}`);
  return ROUTES[route as RouteId];
}

function fieldCode(issue: z.core.$ZodIssue): FieldError['code'] {
  if (issue.code === 'custom' && issue.message === 'range_inverted') return 'range_inverted';
  return 'invalid_value';
}

/**
 * Reads a query string the way the API does and names the problem code
 * the API answers with when it does not parse. A key given twice is refused
 * rather than silently reading one of the values.
 */
export function parseQuery<R extends RouteId>(
  route: R,
  params: URLSearchParams | Readonly<Record<string, string>>,
): QueryResult<R> {
  const definition = routeOf(route);
  const entries =
    params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  const record: Record<string, string> = {};
  const errors: FieldError[] = [];
  for (const [key, value] of entries) {
    if (Object.hasOwn(record, key)) errors.push({ field: key, code: 'invalid_value' });
    record[key] = value;
  }
  const parsed = definition.query.safeParse(record);
  if (parsed.success && errors.length === 0) {
    return { success: true, data: parsed.data as RouteQuery<R> };
  }
  for (const issue of parsed.error?.issues ?? []) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) errors.push({ field: key, code: 'unknown_field' });
    } else {
      errors.push({ field: issue.path.map(String).join('.') || '(query)', code: fieldCode(issue) });
    }
  }
  const fields = new Set(errors.map((e) => e.field));
  const only = (name: string): boolean => fields.size === 1 && fields.has(name);
  const code: ProblemCode =
    only('cursor') || only('depositsCursor')
      ? 'INVALID_CURSOR'
      : only('limit') || only('depositsLimit')
        ? 'LIMIT_OUT_OF_RANGE'
        : 'INVALID_FILTER';
  return { success: false, code, errors };
}

function issuesOf(error: z.ZodError): ContractIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/**
 * Checks one response body against its route's contract and returns it
 * typed. A 2xx body must match the route's response schema; any other
 * status must be one the route declares and carry a matching problem body.
 */
export function assertMatchesSchema<R extends RouteId>(
  route: R,
  body: unknown,
  status?: 200,
): RouteResponse<R>;
export function assertMatchesSchema(route: RouteId, body: unknown, status: number): unknown;
export function assertMatchesSchema(route: RouteId, body: unknown, status = 200): unknown {
  const definition = routeOf(route);
  if (status === 200) {
    const parsed = definition.response.safeParse(body);
    if (!parsed.success) throw new ContractMismatchError(route, status, issuesOf(parsed.error));
    return parsed.data;
  }
  if (!(definition.errors as readonly number[]).includes(status)) {
    throw new ContractMismatchError(route, status, [
      { path: '', message: 'the route does not answer with this status' },
    ]);
  }
  const parsed = Problem.safeParse(body);
  if (!parsed.success) throw new ContractMismatchError(route, status, issuesOf(parsed.error));
  if (parsed.data.status !== status) {
    throw new ContractMismatchError(route, status, [
      { path: 'status', message: 'body status differs from the HTTP status' },
    ]);
  }
  return parsed.data;
}

const JSON_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ok: 'application/json',
  problem: 'application/problem+json',
});

/**
 * The same check for a fetch Response, plus the headers the contract fixes:
 * the content type and a Request-Id that matches a problem's requestId.
 */
export async function assertResponseMatchesSchema(
  route: RouteId,
  response: Response,
): Promise<unknown> {
  const status = response.status;
  const expectedType = status === 200 ? JSON_TYPES['ok'] : JSON_TYPES['problem'];
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim();
  if (contentType !== expectedType) {
    throw new ContractMismatchError(route, status, [
      { path: '', message: `content type must be ${String(expectedType)}` },
    ]);
  }
  const requestId = response.headers.get('request-id');
  if (requestId === null) {
    throw new ContractMismatchError(route, status, [
      { path: '', message: 'the Request-Id header is missing' },
    ]);
  }
  const body: unknown = await response.json();
  const checked = assertMatchesSchema(route, body, status);
  if (status !== 200 && (checked as Problem).requestId !== requestId) {
    throw new ContractMismatchError(route, status, [
      { path: 'requestId', message: 'differs from the Request-Id header' },
    ]);
  }
  return checked;
}
