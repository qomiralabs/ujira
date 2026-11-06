// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The one way the dashboard talks to the UJIRA API. Every screen goes through
// request(), which sends the session cookie and the chosen project, checks
// every answer against its schema, and turns a problem body into an
// ApiProblem a screen can branch on by code.
//
// Nothing here logs or keeps a request or a response. Some answers carry a
// secret that may be shown once (a new API key), so a body is never put into
// an error, a message or a cache.

import { z } from 'zod';

export type Method = 'GET' | 'POST';

export interface RequestSpec<T> {
  method: Method;
  /** The API path, starting with /v1/. */
  path: string;
  /** The project the request acts in, from the URL. */
  project: string;
  query?: Readonly<Record<string, string | undefined>>;
  body?: unknown;
  schema: z.ZodType<T>;
  signal?: AbortSignal | undefined;
}

export interface DataClient {
  request<T>(spec: RequestSpec<T>): Promise<T>;
}

export interface DataClientOptions {
  /** Where the API is. The page's own origin when left out. */
  baseUrl?: string | undefined;
  fetch?: typeof fetch;
}

/** The header that names the project a request acts in. */
export const PROJECT_HEADER = 'Ujira-Project';

export interface FieldError {
  readonly field: string;
  readonly code: string;
}

/** The API answered with a problem body. Branch on `code`; quote `requestId` to support. */
export class ApiProblem extends Error {
  override readonly name = 'ApiProblem';
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly fieldErrors: readonly FieldError[];

  constructor(status: number, code: string, requestId: string, fieldErrors: readonly FieldError[]) {
    super(`${String(status)} ${code}`);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.fieldErrors = fieldErrors;
  }

  /** True when the request was refused by a field rule on one of these fields. */
  hasFieldError(field: string): boolean {
    return this.fieldErrors.some((e) => e.field === field);
  }
}

export type DataErrorKind = 'network' | 'invalid_response' | 'aborted';

/** The request did not get a usable answer: no connection, a body that did not parse, or an abort. */
export class DataError extends Error {
  override readonly name = 'DataError';
  readonly kind: DataErrorKind;
  readonly status: number | null;
  readonly requestId: string | null;

  constructor(kind: DataErrorKind, status: number | null = null, requestId: string | null = null) {
    super(status === null ? kind : `${kind} (${String(status)})`);
    this.kind = kind;
    this.status = status;
    this.requestId = requestId;
  }
}

/** The reference a person can quote to support for any failure, when there is one. */
export function referenceOf(error: unknown): string | undefined {
  if (error instanceof ApiProblem) return error.requestId;
  if (error instanceof DataError) return error.requestId ?? undefined;
  return undefined;
}

// Lenient on purpose: the API adds codes over time, and a code this build has
// never seen must still read as a problem, not as a broken answer.
const ProblemBody = z.object({
  status: z.number().int().min(400).max(599),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  errors: z
    .array(z.object({ field: z.string().min(1).max(200), code: z.string().min(1).max(64) }))
    .max(50)
    .optional(),
});

function urlFor(spec: RequestSpec<unknown>, baseUrl: string): URL {
  const url = new URL(spec.path, baseUrl);
  for (const [name, value] of Object.entries(spec.query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');
}

async function readJson(response: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await response.text();
  if (text === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function createDataClient(options: DataClientOptions = {}): DataClient {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl ?? window.location.origin;

  return {
    async request<T>(spec: RequestSpec<T>): Promise<T> {
      const headers = new Headers({ Accept: 'application/json', [PROJECT_HEADER]: spec.project });
      const init: RequestInit = {
        method: spec.method,
        headers,
        credentials: 'include',
        cache: 'no-store',
        signal: spec.signal ?? null,
      };
      if (spec.body !== undefined) {
        headers.set('Content-Type', 'application/json');
        init.body = JSON.stringify(spec.body);
      }

      let response: Response;
      try {
        response = await send(urlFor(spec, baseUrl), init);
      } catch (error) {
        throw new DataError(isAbort(error, spec.signal) ? 'aborted' : 'network');
      }

      const headerId = response.headers.get('Request-Id');
      let body: Awaited<ReturnType<typeof readJson>>;
      try {
        body = await readJson(response);
      } catch (error) {
        throw new DataError(isAbort(error, spec.signal) ? 'aborted' : 'network');
      }

      if (!response.ok) {
        const problem = body.ok ? ProblemBody.safeParse(body.value) : null;
        if (problem?.success !== true) {
          throw new DataError('invalid_response', response.status, headerId);
        }
        const { status, code, requestId, errors } = problem.data;
        throw new ApiProblem(status, code, requestId, errors ?? []);
      }

      if (!body.ok) throw new DataError('invalid_response', response.status, headerId);
      const parsed = spec.schema.safeParse(body.value);
      // The issues are dropped, not attached: they can quote the input, and
      // the input can be a secret.
      if (!parsed.success) throw new DataError('invalid_response', response.status, headerId);
      return parsed.data;
    },
  };
}
