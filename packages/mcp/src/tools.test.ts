// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Every tool through a real MCP client, against the fake API from the contract.

import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MandatePage, PayoutPage, ReceiptPage, ROUTES } from '@ujira/api-schema';
import { describe, expect, it } from 'vitest';

import { createApiClient } from './client.js';
import { API_KEY, API_URL, HOME, fakeApi, fixtures } from './fake-api.test-support.js';
import type { FakeApi } from './fake-api.test-support.js';
import { createMcpServer } from './server.js';
import type { McpServerOptions } from './server.js';
import { TOOLS, inputSchemaOf } from './tools.js';

async function connected(
  api: FakeApi,
  options: Partial<McpServerOptions> & { readonly apiKey?: string } = {},
) {
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  const client = createApiClient({
    apiUrl: API_URL,
    apiKey: options.apiKey ?? API_KEY,
    fetch: api.fetch,
  });
  await createMcpServer({ client, ...options }).connect(ours);
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(theirs);
  return mcp;
}

async function called(mcp: Client, name: string, args: Record<string, unknown> = {}) {
  return (await mcp.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  const [first] = result.content;
  if (first?.type !== 'text') throw new Error('the result holds no text');
  return first.text;
}

const mine = <T extends { readonly projectId: string }>(rows: readonly T[]): T => {
  const row = rows.find((candidate) => candidate.projectId === HOME.projectId);
  if (row === undefined) throw new Error('the fixtures hold no row for this tenant');
  return row;
};

// Every tool in the table must have a row, so a new tool cannot go untested.
const CALLS: Readonly<Record<string, Record<string, string>>> = {
  list_payouts: { limit: '2' },
  get_payout: { id: mine(fixtures.payouts).id },
  list_receipts: { limit: '2' },
  get_receipt: { id: mine(fixtures.receipts).id },
  list_mandates: { limit: '2' },
  get_mandate: { id: mine(fixtures.mandates).id },
};

describe('the tool table', () => {
  it('lists every tool, marked read only and saying what scope it needs', async () => {
    const mcp = await connected(fakeApi());
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    for (const listed of tools) {
      const tool = TOOLS.find((candidate) => candidate.name === listed.name);
      expect(listed.annotations?.readOnlyHint).toBe(true);
      expect(listed.description).toContain(tool?.scope);
      expect(listed.inputSchema['additionalProperties']).toBe(false);
    }
    await mcp.close();
  });

  it('requires an id exactly where the route has one', () => {
    for (const tool of TOOLS) {
      const needsId = ROUTES[tool.route].path.includes('{id}');
      expect(inputSchemaOf(tool).required ?? [], tool.name).toEqual(needsId ? ['id'] : []);
    }
  });

  it('shows text inputs, as the contract takes them', () => {
    const list = TOOLS.find((tool) => tool.name === 'list_payouts');
    if (list === undefined) throw new Error('no such tool');
    expect(inputSchemaOf(list).properties['limit']).toMatchObject({ type: 'string' });
  });

  it('offers no network filter, and refuses one', async () => {
    for (const tool of TOOLS) {
      expect(Object.keys(inputSchemaOf(tool).properties), tool.name).not.toContain('network');
    }
    const api = fakeApi();
    const mcp = await connected(api);
    const result = await called(mcp, 'list_payouts', { network: 'stellar:testnet' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('network (unknown_field)');
    expect(api.requests).toEqual([]);
    await mcp.close();
  });
});

describe('calling a tool', () => {
  it('every tool returns what its route returns', async () => {
    expect(Object.keys(CALLS).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
    const api = fakeApi();
    const mcp = await connected(api);
    for (const tool of TOOLS) {
      const args = CALLS[tool.name] ?? {};
      const result = await called(mcp, tool.name, args);
      expect(result.isError ?? false, tool.name).toBe(false);
      const value = JSON.parse(textOf(result)) as unknown;
      expect(ROUTES[tool.route].response.safeParse(value).success, tool.name).toBe(true);
      const request = api.requests.at(-1);
      expect(request?.method).toBe('GET');
      expect(new URL(request?.url ?? '').pathname).toBe(
        ROUTES[tool.route].path.replace('{id}', args['id'] ?? ''),
      );
    }
    await mcp.close();
  });

  it.each([
    ['list_payouts', PayoutPage],
    ['list_receipts', ReceiptPage],
    ['list_mandates', MandatePage],
  ] as const)('%s pages with the cursor it was given', async (name, Page) => {
    const mcp = await connected(fakeApi());
    const first = Page.parse(JSON.parse(textOf(await called(mcp, name, { limit: '1' }))));
    expect(first.items).toHaveLength(1);
    if (first.nextCursor === null) throw new Error('the fixtures fill only one page');
    const second = Page.parse(
      JSON.parse(textOf(await called(mcp, name, { limit: '1', cursor: first.nextCursor }))),
    );
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    await mcp.close();
  });

  it('passes a filter on exactly as it was sent', async () => {
    const api = fakeApi();
    const mcp = await connected(api);
    const result = await called(mcp, 'list_payouts', { status: 'paid,failed', limit: '3' });
    expect(result.isError ?? false).toBe(false);
    expect(new URL(api.requests[0]?.url ?? '').search).toBe('?status=paid%2Cfailed&limit=3');
    await mcp.close();
  });
});

describe('what comes back as a tool error', () => {
  it.each([
    ['an id that is no id', 'get_payout', { id: 'nope' }, 'id (invalid_value)'],
    ['no id at all', 'get_payout', {}, 'id (invalid_value)'],
    ['a field the route has not got', 'list_payouts', { colour: 'blue' }, 'colour (unknown_field)'],
    ['a limit out of range', 'list_payouts', { limit: '500' }, 'limit'],
    ['a limit that is not text', 'list_payouts', { limit: 5 }, 'limit (invalid_value)'],
    ['a status off the list', 'list_payouts', { status: 'shipped' }, 'status'],
  ])('bad input is a tool error and makes no call: %s', async (_name, tool, args, expected) => {
    const api = fakeApi();
    const mcp = await connected(api);
    const result = await called(mcp, tool, args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(expected);
    expect(api.requests).toEqual([]);
    await mcp.close();
  });

  it('names the field and never echoes the value', async () => {
    const pasted = `S${'A'.repeat(55)}`;
    const api = fakeApi();
    const mcp = await connected(api);
    for (const args of [{ id: pasted }, { limit: pasted }, { [pasted]: 'x' }]) {
      const result = await called(mcp, 'list_payouts', args);
      expect(result.isError).toBe(true);
    }
    const result = await called(mcp, 'get_payout', { id: pasted });
    expect(textOf(result)).not.toContain(pasted);
    const limit = await called(mcp, 'list_payouts', { limit: pasted });
    expect(textOf(limit)).not.toContain(pasted);
    expect(api.requests).toEqual([]);
    await mcp.close();
  });

  it('a 404 is a tool error with its code', async () => {
    const mcp = await connected(fakeApi());
    const result = await called(mcp, 'get_payout', { id: randomUUID() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^NOT_FOUND: .*\(request .+\)$/);
    await mcp.close();
  });

  it('another tenant reads as not found', async () => {
    const other = fixtures.payouts.find((payout) => payout.projectId !== HOME.projectId);
    if (other === undefined) throw new Error('the fixtures hold one tenant');
    const mcp = await connected(fakeApi());
    const result = await called(mcp, 'get_payout', { id: other.id });
    expect(textOf(result)).toMatch(/^NOT_FOUND/);
    await mcp.close();
  });

  it('a refused key is a tool error, and does not show the key', async () => {
    const wrong = `ujk_test_${'c'.repeat(16)}_${'d'.repeat(59)}`;
    const mcp = await connected(fakeApi(), { apiKey: wrong });
    const result = await called(mcp, 'list_payouts');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^TOKEN_/);
    expect(textOf(result)).not.toContain(wrong);
    await mcp.close();
  });

  it('a bug here is reported by name, and tells the agent nothing about it', async () => {
    const reported: string[] = [];
    const [ours, theirs] = InMemoryTransport.createLinkedPair();
    await createMcpServer({
      client: { read: () => Promise.reject(new RangeError('private detail')) },
      onInternalError: (name) => {
        reported.push(name);
      },
    }).connect(ours);
    const mcp = new Client({ name: 'test', version: '0.0.0' });
    await mcp.connect(theirs);
    const result = await called(mcp, 'list_payouts');
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('private detail');
    expect(reported).toEqual(['RangeError']);
    await mcp.close();
  });

  it('a tool that does not exist is refused by the protocol', async () => {
    const mcp = await connected(fakeApi());
    await expect(called(mcp, 'pay_everyone')).rejects.toThrow('no such tool');
    await mcp.close();
  });
});
