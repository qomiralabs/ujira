// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { API_KEY } from './fake-api.test-support.js';
import { runServer } from './run.js';
import { SERVER_NAME, createMcpServer } from './server.js';

async function connected(run: (transport: InMemoryTransport) => Promise<unknown>) {
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  await run(ours);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(theirs);
  return client;
}

describe('the server', () => {
  it('an MCP client connects and lists the tools', async () => {
    const client = await connected((transport) => createMcpServer().connect(transport));
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect((await client.listTools()).tools).toEqual([]);
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
      createMcpServer({ tools: [tool] }).connect(transport),
    );
    expect((await client.listTools()).tools.map((listed) => listed.name)).toEqual(['a_tool']);
    await client.close();
  });
});

describe('starting it', () => {
  it('serves with a good environment, and says nothing', async () => {
    const lines: string[] = [];
    let code: number | undefined;
    const client = await connected(async (transport) => {
      code = await runServer(
        { UJIRA_API_KEY: API_KEY, UJIRA_API_URL: 'https://api.ujira.test' },
        {
          transport,
          stderr: (line) => {
            lines.push(line);
          },
        },
      );
    });
    expect(code).toBe(0);
    expect(lines).toEqual([]);
    expect((await client.listTools()).tools).toEqual([]);
    await client.close();
  });

  it('refuses a bad environment with one line that holds none of its values', async () => {
    const [ours] = InMemoryTransport.createLinkedPair();
    const lines: string[] = [];
    const secret = `S${'A'.repeat(55)}`;
    const code = await runServer(
      { UJIRA_API_KEY: secret, UJIRA_API_URL: 'https://api.ujira.test' },
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
