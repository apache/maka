/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { Tool } from '@modelcontextprotocol/client';
import { formatMcpDiagnosticText } from './diagnostic-text.js';
import { fingerprintMcpToolDefinition } from './tool-definition.js';

export const DEFAULT_TOOL_DISCOVERY_LIMITS = {
  maxPages: 1_000,
  maxTools: 1_000,
  maxDefinitionBytes: 16 * 1_048_576,
} as const;

export interface McpToolPage {
  readonly tools: readonly Tool[];
  readonly nextCursor?: string;
}

export interface McpToolPageSource {
  requestToolsPage(cursor: string | undefined, timeoutMs: number): Promise<McpToolPage>;
}

export interface McpToolDiscoveryLimits {
  readonly maxPages: number;
  readonly maxTools: number;
  readonly maxDefinitionBytes: number;
}

export interface McpDiscoveredTool {
  readonly definition: Tool;
  readonly definitionFingerprint: string;
}

/**
 * Walk tools/list without delegating aggregation or cache ownership to the SDK.
 *
 * Cursors are opaque: an empty string is a continuation, and only undefined
 * terminates the walk.
 */
export async function discoverMcpTools(
  source: McpToolPageSource,
  serverId: string,
  timeoutMs: number,
  limits: McpToolDiscoveryLimits = DEFAULT_TOOL_DISCOVERY_LIMITS,
): Promise<McpDiscoveredTool[]> {
  const result: McpDiscoveredTool[] = [];
  const seenCursors = new Set<string>();
  const seenNames = new Set<string>();
  let definitionBytes = 0;
  let cursor: string | undefined;

  for (let page = 0; page < limits.maxPages; page += 1) {
    const response = await source.requestToolsPage(cursor, timeoutMs);
    for (const tool of response.tools) {
      if (result.length >= limits.maxTools) {
        throw new Error(`MCP server "${serverId}" exceeded ${limits.maxTools} tools`);
      }
      if (seenNames.has(tool.name)) {
        throw new Error(
          `MCP server "${serverId}" returned duplicate tool ${JSON.stringify(
            formatMcpDiagnosticText(tool.name),
          )}`,
        );
      }
      seenNames.add(tool.name);
      const fingerprint = fingerprintMcpToolDefinition(tool);
      definitionBytes += fingerprint.bytes;
      if (definitionBytes > limits.maxDefinitionBytes) {
        throw new Error(
          `MCP server "${serverId}" exceeded ${limits.maxDefinitionBytes} tool definition bytes`,
        );
      }
      result.push({
        definition: structuredClone(tool),
        definitionFingerprint: fingerprint.value,
      });
    }

    if (response.nextCursor === undefined) return result;
    if (seenCursors.has(response.nextCursor)) {
      throw new Error(`MCP server "${serverId}" repeated a tools cursor`);
    }
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }

  throw new Error(`MCP server "${serverId}" exceeded ${limits.maxPages} tool pages`);
}
