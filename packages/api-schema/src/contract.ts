// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import type { z } from 'zod';

import { FieldErrorCode, PROBLEM_CODES, PROBLEM_TYPE_BASE, Problem } from './envelope.js';
import type { ProblemCode, ProblemFix } from './envelope.js';
import { ContractMismatchError, UnknownRouteError } from './errors.js';
import type { ContractIssue } from './errors.js';
import { ROUTES } from './routes.js';
import type { RouteId, RouteQuery, RouteResponse } from './routes.js';

/** The fixed title of each code. Titles never carry request data. */
export const PROBLEM_TITLES: Readonly<Record<ProblemCode, string>> = Object.freeze({
  INVALID_FILTER: 'The filter is not valid',
  INVALID_CURSOR: 'The cursor is not valid for this list',
  LIMIT_OUT_OF_RANGE: 'The limit must be from 1 to 200',
  INVALID_AMOUNT: 'The amount is not an integer count of minor units',
  INVALID_REQUEST: 'The request is not valid',
  IDEMPOTENCY_KEY_INVALID: 'The Idempotency-Key header is missing or not valid',
  WEBHOOK_SIGNATURE_INVALID: 'The webhook signature is not valid',
  WEBHOOK_PAYLOAD_INVALID: 'The webhook body is not valid',
  WEBHOOK_REJECTED: 'The webhook is for another environment or flow',
  TOKEN_MALFORMED: 'The API key is missing or malformed',
  TOKEN_INVALID: 'The API key is not valid',
  TOKEN_ENVIRONMENT_MISMATCH: 'The API key is for another environment',
  EMBED_TOKEN_INVALID: 'The embed session is not valid',
  INSUFFICIENT_SCOPE: 'The API key lacks the scope this route needs',
  ORIGIN_NOT_ALLOWED: 'The request origin is not allowed',
  EMBED_SCOPE_VIOLATION: 'The embed session cannot reach this route',
  NOT_FOUND: 'Not found',
  METHOD_NOT_ALLOWED: 'The route does not accept this method',
  IDEMPOTENCY_IN_PROGRESS: 'A request with this Idempotency-Key is still running',
  PAYLOAD_TOO_LARGE: 'The request body is too large',
  UNSUPPORTED_MEDIA_TYPE: 'The request body must be application/json',
  DESTINATION_INVALID: 'The destination cannot receive this payout',
  MANDATE_REFUSED: 'The mandate does not allow this',
  QUOTE_UNAVAILABLE: 'No quote is available for this payout right now',
  WALLET_PROOF_INVALID: 'The wallet proof is not valid',
  WALLET_PROOF_EXPIRED: 'The wallet proof challenge has expired',
  WALLET_SIGNER_NOT_AUTHORIZED: 'That key cannot sign for this wallet',
  DESTINATION_NOT_RECEIVABLE: 'This destination cannot receive a payout yet',
  FEE_CAP_INVALID: 'The fee cap can be at most 100 basis points',
  PRINCIPAL_KEY_RISK: 'Above 50,000 USD a mandate needs a multisig principal or a recovery set',
  CUSTODY_GUARD: 'A mandate with a UJIRA held agent key must use allowlist or both mode',
  TRANSFER_FAILED: 'The principal could not receive the transfer',
  IDEMPOTENCY_KEY_REUSED: 'This Idempotency-Key was used for a different request',
  RATE_LIMITED: 'Too many requests',
  INTERNAL: 'Something went wrong on our side',
  DB_UNAVAILABLE: 'The service is temporarily unavailable',
  CHAIN_UNAVAILABLE: 'The network is temporarily unavailable',
  REQUEST_TIMEOUT: 'The request took too long',
  WEBHOOK_UNAVAILABLE: 'This webhook cannot be received right now',
  OPERATIONS_GUARDIAN_NOT_CONFIGURED: 'No operations guardian is set up for this network yet',
});

export interface FieldError {
  readonly field: string;
  readonly code: z.infer<typeof FieldErrorCode>;
}

/** A problem body that always passes its own schema. */
export function buildProblem(
  code: ProblemCode,
  requestId: string,
  extra: {
    readonly detail?: string;
    readonly errors?: readonly FieldError[];
    readonly fixes?: readonly ProblemFix[];
  } = {},
): Problem {
  return {
    type: `${PROBLEM_TYPE_BASE}${code}`,
    title: PROBLEM_TITLES[code],
    status: PROBLEM_CODES[code],
    code,
    requestId,
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    ...(extra.errors === undefined || extra.errors.length === 0
      ? {}
      : { errors: [...extra.errors] }),
    ...(extra.fixes === undefined || extra.fixes.length === 0 ? {} : { fixes: [...extra.fixes] }),
  };
}

export type QueryResult<R extends RouteId> =
  | { readonly success: true; readonly data: RouteQuery<R> }
  | { readonly success: false; readonly code: ProblemCode; readonly errors: readonly FieldError[] };

function routeOf(route: string): (typeof ROUTES)[RouteId] {
  if (!Object.hasOwn(ROUTES, route)) throw new UnknownRouteError(`no route named ${route}`);
  return ROUTES[route as RouteId];
}

// Refinements that stand for a specific field code carry it as their message.
function fieldCode(issue: z.core.$ZodIssue): FieldError['code'] {
  if (issue.code !== 'custom') return 'invalid_value';
  const named = FieldErrorCode.safeParse(issue.message);
  return named.success ? named.data : 'invalid_value';
}

function issueErrors(issues: readonly z.core.$ZodIssue[]): FieldError[] {
  const errors: FieldError[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) errors.push({ field: key, code: 'unknown_field' });
    } else {
      errors.push({ field: issue.path.map(String).join('.') || '(query)', code: fieldCode(issue) });
    }
  }
  return errors;
}

/**
 * Reads a query string the way the API does and names the problem code
 * the API answers with when it does not parse. A key given twice is refused
 * rather than silently reading one of the values.
 *
 * Every value of a repeated key is checked, not only the last, and a bad
 * value decides the code before the repeat does. So `limit=5&limit=500`
 * answers LIMIT_OUT_OF_RANGE, which tells the client what to fix, and still
 * lists the repeat among the errors; a repeat whose values are all valid
 * answers INVALID_FILTER.
 */
export function parseQuery<R extends RouteId>(
  route: R,
  params: URLSearchParams | Readonly<Record<string, string>>,
): QueryResult<R> {
  const definition = routeOf(route);
  const entries =
    params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  const record: Record<string, string> = {};
  const earlier: [string, string][] = [];
  const repeats: FieldError[] = [];
  for (const [key, value] of entries) {
    if (Object.hasOwn(record, key)) {
      repeats.push({ field: key, code: 'repeated_key' });
      earlier.push([key, record[key] ?? '']);
    }
    record[key] = value;
  }
  const parsed = definition.query.safeParse(record);
  if (parsed.success && repeats.length === 0) {
    return { success: true, data: parsed.data as RouteQuery<R> };
  }
  const values = issueErrors(parsed.error?.issues ?? []);
  const seen = new Set(values.map((e) => `${e.field} ${e.code}`));
  for (const [key, value] of earlier) {
    const again = definition.query.safeParse({ ...record, [key]: value });
    for (const error of issueErrors(again.error?.issues ?? [])) {
      const id = `${error.field} ${error.code}`;
      if (error.field === key && !seen.has(id)) {
        seen.add(id);
        values.push(error);
      }
    }
  }
  const errors = [...repeats, ...values];
  const fields = new Set(errors.map((e) => e.field));
  const only = (name: string): boolean =>
    values.length > 0 && fields.size === 1 && fields.has(name);
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
