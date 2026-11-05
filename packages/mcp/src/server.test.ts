// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { createApiClient } from './client.js';
import { API_KEY, API_URL, fakeApi } from './fake-api.test-support.js';
import { runServer } from './run.js';
import { SERVER_NAME, createMcpServer } from './server.js';
import { TOOLS } from './tools.js';

const NO_CALLS = { read: () => Promise.reject(new Error('a call was made')) };

async function connected(run: (transport: InMemoryTransport) => Promise<unknown>) {
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  await run(ours);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(theirs);
  return client;
}

describe('the server', () => {
  it('an MCP client connects and lists the tools', async () => {
    const client = await connected((transport) =>
      createMcpServer({ client: NO_CALLS }).connect(transport),
    );
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect((await client.listTools()).tools).toHaveLength(TOOLS.length);
    await client.close();
  });

  it('lists what it was given', async () => {
    const tool = {
      name: 'a_tool',
      description: 'A tool',
      route: 'listPayouts' as const,
      scope: 'payouts:read',
    };
    const client = await connected((transport) =>
      createMcpServer({ client: NO_CALLS, tools: [tool] }).connect(transport),
    );
    expect((await client.listTools()).tools.map((listed) => listed.name)).toEqual(['a_tool']);
    await client.close();
  });
});

describe('starting it', () => {
  const GOOD = { UJIRA_API_KEY: API_KEY, UJIRA_API_URL: API_URL };

  it('serves with a good environment, says nothing, and calls with the key', async () => {
    const lines: string[] = [];
    const api = fakeApi();
    let code: number | undefined;
    const client = await connected(async (transport) => {
      code = await runServer(GOOD, {
        transport,
        createClient: (config) => createApiClient({ ...config, fetch: api.fetch }),
        stderr: (line) => {
          lines.push(line);
        },
      });
    });
    expect(code).toBe(0);
    const result = await client.callTool({ name: 'list_payouts', arguments: { limit: '1' } });
    expect(result.isError ?? false).toBe(false);
    expect(api.requests[0]?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(lines).toEqual([]);
    await client.close();
  });

  it('uses the real fetch when it is given none', async () => {
    const client = await connected((transport) =>
      runServer(
        { UJIRA_API_KEY: API_KEY, UJIRA_API_URL: 'http://127.0.0.1:9' },
        { transport, stderr: () => undefined },
      ),
    );
    const result = await client.callTool({ name: 'list_payouts' });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('reports a bug on stderr by name, without its message', async () => {
    const lines: string[] = [];
    const client = await connected((transport) =>
      runServer(GOOD, {
        transport,
        createClient: () => ({ read: () => Promise.reject(new RangeError('private detail')) }),
        stderr: (line) => {
          lines.push(line);
        },
      }),
    );
    const result = await client.callTool({ name: 'list_payouts' });
    expect(result.isError).toBe(true);
    expect(lines).toEqual(['ujira-mcp: internal error RangeError\n']);
    await client.close();
  });

  it('does not hide a failure that is not about the configuration', async () => {
    const [ours] = InMemoryTransport.createLinkedPair();
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new RangeError('not a config problem');
        },
      },
    );
    await expect(
      runServer(hostile, { transport: ours, stderr: () => undefined }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('refuses a bad environment with one line that holds none of its values', async () => {
    const [ours] = InMemoryTransport.createLinkedPair();
    const lines: string[] = [];
    const secret = `S${'A'.repeat(55)}`;
    const code = await runServer(
      { UJIRA_API_KEY: secret, UJIRA_API_URL: API_URL },
      {
        transport: ours,
        stderr: (line) => {
          lines.push(line);
        },
      },
    );
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ujira-mcp: UJIRA_API_KEY/);
    expect(lines[0]).not.toContain(secret);
  });
});
