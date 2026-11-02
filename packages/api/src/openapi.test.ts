// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Generates the API's OpenAPI document and checks it against the committed
// copy in openapi/openapi.json. `pnpm --filter @ujira/api openapi:check`
// runs this file in CI; after changing a route, refresh the copy with
// `pnpm --filter @ujira/api openapi` and review the diff.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from './app.js';
import { refuseAllCredentials } from './auth.js';
import { RouteRegistryError } from './errors.js';
import { memoryLogger } from './log.js';
import { OPENAPI_PATH, buildOpenApiDocument, withOpenApiRoute } from './openapi.js';
import { contractRoute, definePublicRoute, defineTenantRoute } from './route.js';
import { V1_ROUTES } from './routes/index.js';

const FILE = join(import.meta.dirname, '..', 'openapi', 'openapi.json');

async function formatted(document: unknown): Promise<string> {
  const config = (await resolveConfig(FILE)) ?? {};
  return format(JSON.stringify(document), { ...config, parser: 'json', filepath: FILE });
}

interface Operation {
  operationId: string;
  security: unknown[];
  'x-ujira-scope'?: string;
  parameters: { name: string; in: string }[];
  requestBody?: { content: Record<string, { schema: unknown }> };
  responses: Record<string, { headers: Record<string, unknown>; description: string }>;
}
interface Document {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
}

describe('OpenAPI document', () => {
  it('matches the committed openapi/openapi.json', async () => {
    const text = await formatted(withOpenApiRoute(V1_ROUTES).document);
    if (process.env['UJIRA_WRITE_OPENAPI'] === '1') writeFileSync(FILE, text);
    expect(readFileSync(FILE, 'utf8')).toBe(text);
  });

  it('is what the server serves at /v1/openapi.json', async () => {
    const app = createApp({
      routes: V1_ROUTES,
      authenticate: refuseAllCredentials,
      logger: memoryLogger(),
    });
    const response = await app.request(OPENAPI_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(withOpenApiRoute(V1_ROUTES).document);
  });

  it('lists every route with its responses and resolves every reference', () => {
    const doc = withOpenApiRoute(V1_ROUTES).document as unknown as Document;
    expect(doc.openapi).toBe('3.1.1');
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/v1/health',
      '/v1/identity/self-webhook',
      OPENAPI_PATH,
      '/v1/recipients/{id}/methods/{methodId}/wallet-challenges',
      '/v1/recipients/{id}/methods/{methodId}/wallet-proofs',
    ]);
    const health = doc.paths['/v1/health']?.['get'];
    expect(health?.operationId).toBe('getHealth');
    expect(health?.security).toEqual([]);
    expect(Object.keys(health?.responses ?? {}).sort()).toEqual(['200', '400', '500', '503']);
    expect(health?.responses['503']?.headers).toHaveProperty('Retry-After');
    expect(health?.responses['503']?.description).toContain('DB_UNAVAILABLE');
    const text = JSON.stringify(doc);
    const refs = [...text.matchAll(/"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1] ?? '');
    for (const ref of refs) expect(doc.components.schemas[ref], ref).toBeDefined();
    // Only what the routes reach: no contract shape the server does not send yet.
    expect(Object.keys(doc.components.schemas).sort()).toEqual([
      'Health',
      'OpenApiDocument',
      'Problem',
      'SelfWebhookAck',
      'WalletChallenge',
      'WalletProofAccepted',
    ]);
  });

  it('describes tenant routes with their scope, body and contract statuses', () => {
    const body = z.strictObject({ amount: z.string() });
    const created = defineTenantRoute({
      id: 'createThing',
      method: 'POST',
      path: '/v1/things',
      summary: 'Create a thing',
      scope: 'payouts:write',
      body,
      response: { status: 201, name: 'Thing', schema: z.strictObject({ id: z.string() }) },
      errors: ['DESTINATION_INVALID'],
      handler: () => Promise.resolve({ id: 'x' }),
    });
    const listed = contractRoute('listApprovals', {
      scope: 'approvals:write',
      handler: () => Promise.resolve({ items: [], nextCursor: null }),
    });
    const doc = buildOpenApiDocument([created, listed]) as unknown as Document;
    const post = doc.paths['/v1/things']?.['post'];
    expect(post?.security).toEqual([{ bearer: [] }]);
    expect(post?.['x-ujira-scope']).toBe('payouts:write');
    expect(post?.requestBody?.content['application/json']?.schema).toMatchObject({
      type: 'object',
      properties: { amount: { type: 'string' } },
    });
    expect(Object.keys(post?.responses ?? {}).sort()).toEqual(
      ['201', '400', '401', '403', '413', '415', '422', '429', '500', '503'].sort(),
    );
    const list = doc.paths['/v1/approvals']?.['get'];
    expect(list?.operationId).toBe('listApprovals');
    expect(list?.parameters.map((p) => p.name)).toEqual(expect.arrayContaining(['limit']));
    expect(Object.keys(list?.responses ?? {}).sort()).toEqual(
      ['200', '400', '401', '403', '429', '500', '503'].sort(),
    );
    // Reached through the page, so kept: nested components come along.
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['ApprovalPage', 'ApprovalItem', 'Money', 'Problem', 'Thing']),
    );
  });

  it('refuses one component name for two schemas', () => {
    const route = (id: string, path: `/v1/${string}`) =>
      definePublicRoute({
        id,
        method: 'GET',
        path,
        summary: 's',
        reason: 'A test route that holds no tenant data.',
        response: { name: 'Same', schema: z.strictObject({ a: z.string() }) },
        handler: () => Promise.resolve({ a: 'a' }),
      });
    expect(() => buildOpenApiDocument([route('one', '/v1/one'), route('two', '/v1/two')])).toThrow(
      RouteRegistryError,
    );
  });
});
