// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The MCP server over the tool table. It writes nothing but the protocol: over stdio
// anything else on stdout would corrupt the stream a client is reading.
//
// A refusal names the field, never the value. An agent can put anything in an
// argument, a pasted secret included, and what comes back goes into its transcript.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { McpApiError } from './client.js';
import type { ApiClient } from './client.js';
import { TOOLS, inputSchemaOf, parseToolInput } from './tools.js';
import type { ToolDefinition } from './tools.js';

export const SERVER_NAME = 'ujira';
export const SERVER_VERSION = '0.0.0';

export interface McpServerOptions {
  readonly client: ApiClient;
  readonly tools?: readonly ToolDefinition[];
  /** Told the class name of a failure that is a bug here rather than the API's answer. */
  readonly onInternalError?: (errorName: string) => void;
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

export function createMcpServer(options: McpServerOptions): McpServer {
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
      description: `${tool.description} Needs an API key with the ${tool.scope} scope.`,
      inputSchema: inputSchemaOf(tool),
      annotations: { readOnlyHint: true },
    })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (tool === undefined) throw new McpError(ErrorCode.InvalidParams, 'There is no such tool');
    const input = parseToolInput(tool, request.params.arguments);
    if (!input.ok) {
      const fields = input.errors.map((error) => `${error.field} (${error.code})`).join(', ');
      return failure(`The input was refused: ${fields}`);
    }
    try {
      const result = await options.client.read(tool.route, {
        params: input.params,
        query: input.query,
        signal: extra.signal,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      if (error instanceof McpApiError) return failure(error.message);
      options.onInternalError?.(error instanceof Error ? error.name : 'NonError');
      return failure('Something went wrong in the UJIRA server');
    }
  });
  return mcp;
}
