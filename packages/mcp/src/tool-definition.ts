import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/client';

const MAX_TOOL_DEFINITION_DEPTH = 100;
const MAX_TOOL_DEFINITION_NODES = 100_000;
const MAX_TOOL_DEFINITION_BYTES = 1_048_576;

export interface McpToolDefinitionFingerprint {
  value: string;
  bytes: number;
}

export function fingerprintMcpToolDefinition(tool: Tool): McpToolDefinitionFingerprint {
  const state = { nodes: 0, scalarBytes: 0 };
  const canonical = JSON.stringify(canonicalizeToolValue(tool, state, 0));
  const bytes = Buffer.byteLength(canonical);
  if (bytes > MAX_TOOL_DEFINITION_BYTES) {
    throw new Error(`MCP tool definition exceeds ${MAX_TOOL_DEFINITION_BYTES} bytes`);
  }
  return {
    value: createHash('sha256').update(canonical).digest('base64url'),
    bytes,
  };
}

function canonicalizeToolValue(
  value: unknown,
  state: { nodes: number; scalarBytes: number },
  depth: number,
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_TOOL_DEFINITION_NODES) {
    throw new Error(`MCP tool definition exceeds ${MAX_TOOL_DEFINITION_NODES} values`);
  }
  if (depth > MAX_TOOL_DEFINITION_DEPTH) {
    throw new Error(`MCP tool definition exceeds depth ${MAX_TOOL_DEFINITION_DEPTH}`);
  }
  if (typeof value === 'string') {
    state.scalarBytes += Buffer.byteLength(value);
    assertToolDefinitionBytes(state.scalarBytes);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeToolValue(item, state, depth + 1));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        state.scalarBytes += Buffer.byteLength(key);
        assertToolDefinitionBytes(state.scalarBytes);
        return [key, canonicalizeToolValue(value[key], state, depth + 1)];
      }),
  );
}

function assertToolDefinitionBytes(bytes: number): void {
  if (bytes > MAX_TOOL_DEFINITION_BYTES) {
    throw new Error(`MCP tool definition exceeds ${MAX_TOOL_DEFINITION_BYTES} bytes`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
