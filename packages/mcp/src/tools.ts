// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The tool table. A tool is a row naming a route in the contract and the scope it
// needs, and nothing more, so this server stays a thin adapter that cannot describe
// a route differently from the API.

import type { RouteId } from '@ujira/api-schema';

export interface ToolDefinition {
  /** What an agent calls it, in snake case. */
  readonly name: string;
  /** What an agent reads to decide whether to call it. */
  readonly description: string;
  readonly route: RouteId;
  /** The one scope the API key needs for this tool. */
  readonly scope: string;
}

export const TOOLS: readonly ToolDefinition[] = Object.freeze([]);
