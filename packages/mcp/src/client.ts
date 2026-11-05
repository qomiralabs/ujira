// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The one way this server reaches the API. Paths and response shapes come from the
// contract table, so a route cannot be described differently here. Every call has a
// timeout, and none follows a redirect, because the key would go with it to wherever
// the redirect points.

import { Problem, ROUTES } from '@ujira/api-schema';
import type { RouteId } from '@ujira/api-schema';

const DEFAULT_TIMEOUT_MS = 10_000;

/** What a tool shows an agent, so every message here is fixed text or from the API. */
export class McpApiError extends Error {
  override readonly name: string = 'McpApiError';
}

/** The API answered with a problem body. */
export class ApiProblemError extends McpApiError {
  override readonly name = 'ApiProblemError';
  readonly code: string;
  readonly status: number;
  readonly requestId: string;

  constructor(problem: Problem) {
    super(`${problem.code}: ${problem.detail ?? problem.title} (request ${problem.requestId})`);
    this.code = problem.code;
    this.status = problem.status;
    this.requestId = problem.requestId;
  }
}

/** The API answered with something the contract does not describe. */
export class ApiResponseInvalidError extends McpApiError {
  override readonly name = 'ApiResponseInvalidError';

  constructor(route: RouteId, status: number) {
    super(
      `The API answered ${route} with status ${String(status)}, in a form it does not document`,
    );
  }
}

export class ApiTimeoutError extends McpApiError {
  override readonly name = 'ApiTimeoutError';

  constructor(route: RouteId) {
    super(`The API did not answer ${route} in time`);
  }
}

export class ApiUnreachableError extends McpApiError {
  override readonly name = 'ApiUnreachableError';

  constructor(route: RouteId, options: ErrorOptions) {
    super(`The API could not be reached for ${route}`, options);
  }
}

export interface ReadInput {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ApiClient {
  /** The route's response, checked against the contract. */
  readonly read: (route: RouteId, input?: ReadInput) => Promise<unknown>;
}

export interface ApiClientOptions {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

function pathOf(route: RouteId, params: Readonly<Record<string, string>>): string {
  return ROUTES[route].path.replace(/\{(\w+)\}/g, (_match, name: string) =>
    encodeURIComponent(params[name] ?? ''),
  );
}

function parsedJson(text: string): { readonly ok: boolean; readonly value: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, value: undefined };
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    read: async (route, input = {}) => {
      const url = new URL(pathOf(route, input.params ?? {}), options.apiUrl);
      for (const [name, value] of Object.entries(input.query ?? {})) {
        url.searchParams.set(name, value);
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal =
        input.signal === undefined ? timeout : AbortSignal.any([timeout, input.signal]);
      let status: number;
      let text: string;
      try {
        const response = await send(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
          redirect: 'error',
          signal,
        });
        status = response.status;
        text = await response.text();
      } catch (error) {
        if (timeout.aborted) throw new ApiTimeoutError(route);
        throw new ApiUnreachableError(route, { cause: error });
      }
      const body = parsedJson(text);
      if (!body.ok) throw new ApiResponseInvalidError(route, status);
      if (status >= 400) {
        const problem = Problem.safeParse(body.value);
        if (!problem.success) throw new ApiResponseInvalidError(route, status);
        throw new ApiProblemError(problem.data);
      }
      const checked = ROUTES[route].response.safeParse(body.value);
      if (!checked.success) throw new ApiResponseInvalidError(route, status);
      return body.value;
    },
  };
}
