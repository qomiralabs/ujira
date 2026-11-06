// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// A stand-in for the API key and step up routes, for component tests and the
// browser tests. It keeps the API's rules: a fresh second factor for every
// change, the expiry limits, 20 active keys a project, one rotation a key,
// tenants kept apart, and the whole key in the one answer that creates it.
//
// It is never imported by a page, so it never reaches a bundle. It uses only
// web platform APIs, so it runs in Node, in jsdom and behind page.route.

import {
  API_KEY_MAX_ACTIVE,
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_MIN_EXPIRY_DAYS,
  API_KEY_PRESETS,
  CreateApiKeyRequest,
  RotateApiKeyRequest,
  type ApiKeyListItem,
  type ApiKeyView,
} from './api-keys';
import { PROJECT_HEADER, type FieldError } from './client';
import { STEP_UP_CODE_INVALID, STEP_UP_REQUIRED, StepUpCode } from './session';

/** The code the fake accepts as a fresh second factor. */
export const FAKE_STEP_UP_CODE = '246810';

const STEP_UP_MAX_AGE_MS = 300_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const PRINCIPAL_ID = '7e2c9a1f-5b3d-4c6e-8f0a-9d1b2c3e4f50';

/** The sample projects the shell offers, each its own tenant. */
export const FAKE_PROJECTS: Readonly<Record<string, string>> = {
  labelling: '0b7f3c2a-9d14-4e6b-8c51-2a9e7d4f1b30',
  bounties: '1c8a4d3b-0e25-4f7c-9d62-3b0f8e5a2c41',
  grants: '2d9b5e4c-1f36-4a8d-ae73-4c1a9f6b3d52',
};

const STATUS: Readonly<Record<string, number>> = {
  INVALID_REQUEST: 400,
  INVALID_CURSOR: 400,
  TOKEN_INVALID: 401,
  INSUFFICIENT_SCOPE: 403,
  [STEP_UP_REQUIRED]: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  API_KEY_EXPIRY_INVALID: 422,
  API_KEY_LIMIT_REACHED: 422,
  API_KEY_NOT_ROTATABLE: 422,
  [STEP_UP_CODE_INVALID]: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  DB_UNAVAILABLE: 503,
};

interface StoredKey {
  readonly projectSlug: string;
  readonly id: string;
  readonly name: string | null;
  readonly prefix: string;
  readonly scopes: readonly string[];
  expiresAt: Date;
  revokedAt: Date | null;
  readonly rotatedFromId: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface ServedResponse {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** The body text exactly as sent. */
  readonly body: string;
}

export interface FakeApiOptions {
  now?: () => Date;
  /** Start with sample keys in the first two projects. On by default. */
  seed?: boolean;
}

export interface FakeApi {
  handle(request: Request): Promise<Response>;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Every answer so far, oldest first. */
  readonly served: readonly ServedResponse[];
  /** Forgets the last second factor, as five minutes passing would. */
  expireStepUp(): void;
  /** The next request matching this answers with the problem, once. */
  failNext(match: { method: string; path: string }, code: string): void;
}

function randomText(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET.charAt(byte % 32);
  return out;
}

function seedKeys(now: Date): StoredKey[] {
  const at = (days: number) => new Date(now.getTime() + days * DAY_MS);
  const key = (k: Omit<StoredKey, 'rotatedFromId'> & { rotatedFromId?: string }): StoredKey => ({
    rotatedFromId: null,
    ...k,
  });
  return [
    key({
      projectSlug: 'labelling',
      id: '5f0c1a2e-0000-4000-8000-000000000001',
      name: 'Payroll server',
      prefix: 'ujk_test_pq7rx2mzk4ahwd3e',
      scopes: API_KEY_PRESETS.payouts,
      createdAt: at(-200),
      lastUsedAt: new Date(now.getTime() - 2 * HOUR_MS),
      expiresAt: at(165),
      revokedAt: null,
    }),
    key({
      projectSlug: 'labelling',
      id: '5f0c1a2e-0000-4000-8000-000000000002',
      name: 'Labelling agent',
      prefix: 'ujk_test_lb5nq3vxt6cyre2k',
      scopes: ['payouts:read', 'payouts:write', 'recipients:read'],
      createdAt: at(-355),
      lastUsedAt: new Date(now.getTime() - 26 * HOUR_MS),
      expiresAt: at(10),
      revokedAt: null,
    }),
    key({
      projectSlug: 'labelling',
      id: '5f0c1a2e-0000-4000-8000-000000000003',
      name: 'Reporting',
      prefix: 'ujk_test_rp2wd7kfm3zsnq4h',
      scopes: API_KEY_PRESETS.read_only,
      createdAt: at(-30),
      lastUsedAt: null,
      expiresAt: at(335),
      revokedAt: null,
    }),
    key({
      projectSlug: 'labelling',
      id: '5f0c1a2e-0000-4000-8000-000000000004',
      name: 'Nightly export',
      prefix: 'ujk_test_nx6tj4qbw2pmvc7a',
      scopes: API_KEY_PRESETS.read_only,
      createdAt: at(-400),
      lastUsedAt: at(-21),
      expiresAt: at(330),
      revokedAt: at(-20),
    }),
    key({
      projectSlug: 'labelling',
      id: '5f0c1a2e-0000-4000-8000-000000000005',
      name: 'Staging',
      prefix: 'ujk_test_st3kv5hzq7rmyd2w',
      scopes: API_KEY_PRESETS.full,
      createdAt: at(-95),
      lastUsedAt: at(-6),
      expiresAt: at(-5),
      revokedAt: null,
    }),
    key({
      projectSlug: 'bounties',
      id: '5f0c1a2e-0000-4000-8000-000000000006',
      name: 'Bounty bot',
      prefix: 'ujk_test_bt4mz6qrw3kxpe5n',
      scopes: API_KEY_PRESETS.payouts,
      createdAt: at(-60),
      lastUsedAt: new Date(now.getTime() - 3 * HOUR_MS),
      expiresAt: at(305),
      revokedAt: null,
    }),
  ];
}

export function createFakeApi(options: FakeApiOptions = {}): FakeApi {
  const now = options.now ?? (() => new Date());
  const keys: StoredKey[] = options.seed === false ? [] : seedKeys(now());
  const served: ServedResponse[] = [];
  const failures: { method: string; path: string; code: string }[] = [];
  let steppedUpAt: Date | null = null;
  let counter = 0;

  const nextRequestId = (): string => {
    counter += 1;
    return `req_fake_${String(counter).padStart(8, '0')}`;
  };

  const viewOf = (key: StoredKey): ApiKeyView => ({
    principalId: PRINCIPAL_ID,
    projectId: FAKE_PROJECTS[key.projectSlug] ?? '',
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: [...key.scopes],
    expiresAt: key.expiresAt.toISOString(),
    revokedAt: key.revokedAt === null ? null : key.revokedAt.toISOString(),
    rotatedFromId: key.rotatedFromId,
    createdAt: key.createdAt.toISOString(),
  });

  const listItemOf = (key: StoredKey): ApiKeyListItem => ({
    ...viewOf(key),
    lastUsedAt: key.lastUsedAt === null ? null : key.lastUsedAt.toISOString(),
  });

  const hasSuccessor = (key: StoredKey) => keys.some((k) => k.rotatedFromId === key.id);
  const isLive = (key: StoredKey, at: Date) => key.revokedAt === null && key.expiresAt > at;

  function json(status: number, body: unknown, requestId: string): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Request-Id': requestId },
    });
  }

  function problem(code: string, requestId: string, errors?: readonly FieldError[]): Response {
    const status = STATUS[code] ?? 500;
    const body = {
      type: `https://docs.ujira.co/errors/${code}`,
      title: code.toLowerCase().replace(/_/g, ' '),
      status,
      code,
      requestId,
      ...(errors === undefined ? {} : { errors }),
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/problem+json', 'Request-Id': requestId },
    });
  }

  async function readBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
    const text = await request.text();
    if (text === '') return { ok: true, value: undefined };
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false };
    }
  }

  function stepUpFresh(at: Date): boolean {
    return steppedUpAt !== null && at.getTime() - steppedUpAt.getTime() <= STEP_UP_MAX_AGE_MS;
  }

  async function answer(request: Request, url: URL, requestId: string): Promise<Response> {
    const path = url.pathname;
    const method = request.method;
    const at = now();

    const failure = failures.findIndex((f) => f.method === method && f.path === path);
    if (failure !== -1) {
      const [{ code } = { code: 'INTERNAL' }] = failures.splice(failure, 1);
      return problem(code, requestId);
    }

    const slug = request.headers.get(PROJECT_HEADER) ?? '';
    if (FAKE_PROJECTS[slug] === undefined) return problem('TOKEN_INVALID', requestId);
    const own = keys.filter((k) => k.projectSlug === slug);

    if (path === '/v1/session/step-up') {
      if (method !== 'POST') return problem('METHOD_NOT_ALLOWED', requestId);
      const body = await readBody(request);
      const code =
        body.ok && typeof body.value === 'object' && body.value !== null && 'code' in body.value
          ? StepUpCode.safeParse(body.value.code)
          : null;
      if (code?.success !== true) {
        return problem('INVALID_REQUEST', requestId, [{ field: 'code', code: 'invalid_value' }]);
      }
      if (code.data !== FAKE_STEP_UP_CODE) return problem(STEP_UP_CODE_INVALID, requestId);
      steppedUpAt = at;
      return new Response(null, { status: 204, headers: { 'Request-Id': requestId } });
    }

    if (path === '/v1/api-keys' && method === 'GET') {
      const cursor = url.searchParams.get('cursor');
      const limitText = url.searchParams.get('limit');
      const limit = limitText === null ? PAGE_DEFAULT : Number.parseInt(limitText, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) {
        return problem('INVALID_REQUEST', requestId, [{ field: 'limit', code: 'invalid_value' }]);
      }
      const offset =
        cursor === null ? 0 : /^o[0-9]{1,6}$/.test(cursor) ? Number(cursor.slice(1)) : -1;
      if (offset < 0) {
        return problem('INVALID_CURSOR', requestId, [{ field: 'cursor', code: 'invalid_value' }]);
      }
      const ordered = [...own].sort((a, b) =>
        a.createdAt.getTime() === b.createdAt.getTime()
          ? b.id.localeCompare(a.id)
          : b.createdAt.getTime() - a.createdAt.getTime(),
      );
      const items = ordered.slice(offset, offset + limit).map(listItemOf);
      const next = offset + limit < ordered.length ? `o${String(offset + limit)}` : null;
      return json(200, { items, nextCursor: next }, requestId);
    }

    if (path === '/v1/api-keys' && method === 'POST') {
      if (!stepUpFresh(at)) return problem(STEP_UP_REQUIRED, requestId);
      const body = await readBody(request);
      const parsed = body.ok ? CreateApiKeyRequest.safeParse(body.value) : null;
      if (parsed?.success !== true) {
        const fields = parsed?.error.issues.map((i) => String(i.path[0] ?? 'body')) ?? ['body'];
        return problem(
          'INVALID_REQUEST',
          requestId,
          [...new Set(fields)].map((field) => ({ field, code: 'invalid_value' })),
        );
      }
      const { expiresInDays } = parsed.data;
      if (expiresInDays < API_KEY_MIN_EXPIRY_DAYS || expiresInDays > API_KEY_MAX_EXPIRY_DAYS) {
        return problem('API_KEY_EXPIRY_INVALID', requestId, [
          { field: 'expiresInDays', code: 'invalid_value' },
        ]);
      }
      const active = own.filter((k) => isLive(k, at) && !hasSuccessor(k));
      if (active.length >= API_KEY_MAX_ACTIVE) return problem('API_KEY_LIMIT_REACHED', requestId);
      const scopes =
        'preset' in parsed.data ? API_KEY_PRESETS[parsed.data.preset] : parsed.data.scopes;
      const prefix = `ujk_test_${randomText(16)}`;
      const created: StoredKey = {
        projectSlug: slug,
        id: crypto.randomUUID(),
        name: parsed.data.name,
        prefix,
        scopes: [...scopes],
        expiresAt: new Date(at.getTime() + expiresInDays * DAY_MS),
        revokedAt: null,
        rotatedFromId: null,
        createdAt: at,
        lastUsedAt: null,
      };
      keys.push(created);
      return json(201, { ...viewOf(created), key: `${prefix}_${randomText(59)}` }, requestId);
    }

    const action = /^\/v1\/api-keys\/([^/]+)\/(rotate|revoke)$/.exec(path);
    if (action !== null && method === 'POST') {
      const [, id, verb] = action;
      if (!stepUpFresh(at)) return problem(STEP_UP_REQUIRED, requestId);
      // Another project's key reads exactly like one that never existed.
      const target = own.find((k) => k.id === id);
      if (target === undefined) return problem('NOT_FOUND', requestId);

      if (verb === 'revoke') {
        target.revokedAt ??= at;
        return json(200, viewOf(target), requestId);
      }

      const body = await readBody(request);
      const parsed = body.ok ? RotateApiKeyRequest.safeParse(body.value) : null;
      if (parsed?.success !== true) {
        return problem('INVALID_REQUEST', requestId, [
          { field: 'overlapHours', code: 'invalid_value' },
        ]);
      }
      if (!isLive(target, at) || hasSuccessor(target)) {
        return problem('API_KEY_NOT_ROTATABLE', requestId);
      }
      const lifetime = Math.min(
        target.expiresAt.getTime() - target.createdAt.getTime(),
        API_KEY_MAX_EXPIRY_DAYS * DAY_MS,
      );
      const overlapUntil = new Date(at.getTime() + parsed.data.overlapHours * HOUR_MS);
      // An overlap can only bring an expiry forward, never extend it.
      if (overlapUntil < target.expiresAt) target.expiresAt = overlapUntil;
      const prefix = `ujk_test_${randomText(16)}`;
      const successor: StoredKey = {
        projectSlug: slug,
        id: crypto.randomUUID(),
        name: target.name,
        prefix,
        scopes: [...target.scopes],
        expiresAt: new Date(at.getTime() + lifetime),
        revokedAt: null,
        rotatedFromId: target.id,
        createdAt: at,
        lastUsedAt: null,
      };
      keys.push(successor);
      return json(
        201,
        {
          ...viewOf(successor),
          key: `${prefix}_${randomText(59)}`,
          previousKeyExpiresAt: target.expiresAt.toISOString(),
        },
        requestId,
      );
    }

    return problem('NOT_FOUND', requestId);
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = nextRequestId();
    const response = await answer(request, url, requestId);
    const body = await response.clone().text();
    served.push({ method: request.method, path: url.pathname, status: response.status, body });
    return response;
  }

  return {
    handle,
    fetch: (input, init) => handle(new Request(input, init)),
    served,
    expireStepUp() {
      steppedUpAt = null;
    },
    failNext(match, code) {
      failures.push({ ...match, code });
    },
  };
}
