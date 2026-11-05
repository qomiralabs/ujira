// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The MCP server over the tool table. It writes nothing but the protocol: over stdio
// anything else on stdout would corrupt the stream a client is reading.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { TOOLS } from './tools.js';
import type { ToolDefinition } from './tools.js';

export const SERVER_NAME = 'ujira';
export const SERVER_VERSION = '0.0.0';

export interface McpServerOptions {
  readonly tools?: readonly ToolDefinition[];
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const tools = options.tools ?? TOOLS;
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  // The handlers directly, rather than registerTool, which hands a handler its input
  // after the schema's transforms. A contract's query schema turns text into typed
  // values, and the API must get the text the agent sent.
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object' as const },
    })),
  }));
  return mcp;
}
