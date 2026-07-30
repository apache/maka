import { createHash } from 'node:crypto';
import { jsonSchema } from 'ai';
import type { McpCallResult, McpToolDescriptor } from '@maka/core/mcp';
import type { ToolResultContentPart, ToolResultOutput } from './model-protocol.js';
import type { MakaTool } from './tool-runtime.js';

const MAX_PROVIDER_TOOL_NAME = 64;
const HASH_CHARS = 10;
const MAX_NATIVE_IMAGE_BASE64_CHARS = 20_000_000;
const MAX_NATIVE_IMAGES = 4;
const MAX_MODEL_TEXT_CHARS = 200_000;
const MAX_SUMMARIZED_BLOCKS = 100;
const TRUNCATION_MARKER = '\n…[truncated by Maka]';

export interface McpToolProvider {
  tools(): readonly McpToolDescriptor[];
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<McpCallResult>;
}

export interface BuildMcpToolsOptions {
  callTimeoutMs?: number;
}

export function buildMcpTools(
  provider: McpToolProvider,
  options: BuildMcpToolsOptions = {},
): MakaTool[] {
  const names = new Map<string, string>();
  return provider.tools().map((descriptor) => {
    const identity = `${descriptor.serverId}\0${descriptor.name}`;
    const name = mcpProxyToolName(descriptor.serverId, descriptor.name);
    const collision = names.get(name);
    if (collision && collision !== identity) {
      throw new Error(`MCP proxy tool name collision: ${name}`);
    }
    names.set(name, identity);
    return {
      name,
      description:
        descriptor.description?.trim() ||
        `MCP tool ${descriptor.name} provided by ${descriptor.serverId}`,
      displayName: descriptor.annotations?.title?.trim() || descriptor.name,
      activityKind: 'tool',
      // MCP annotations are advisory server claims, not a security boundary.
      // A remote or local server can mark a mutating tool read-only, so V1
      // always uses the side-effecting network policy and fails closed in
      // explore mode.
      categoryHint: 'network_send',
      parameters: jsonSchema(descriptor.inputSchema),
      permissionArgs: (args) => ({
        serverId: descriptor.serverId,
        toolName: descriptor.name,
        arguments: args,
      }),
      impl: async (args: unknown, context) =>
        provider.callTool(descriptor.serverId, descriptor.name, asArguments(args), {
          signal: context.abortSignal,
          timeoutMs: options.callTimeoutMs,
        }),
      toModelOutput: ({ output }) => mcpResultToModelOutput(output),
    } satisfies MakaTool;
  });
}

export function mcpProxyToolName(serverId: string, toolName: string): string {
  const raw = `mcp__${sanitizeNamePart(serverId)}__${sanitizeNamePart(toolName)}`;
  if (raw.length <= MAX_PROVIDER_TOOL_NAME) return raw;
  const hash = createHash('sha256')
    .update(`${serverId}\0${toolName}`)
    .digest('hex')
    .slice(0, HASH_CHARS);
  return `${raw.slice(0, MAX_PROVIDER_TOOL_NAME - HASH_CHARS - 2)}__${hash}`;
}

function sanitizeNamePart(value: string): string {
  const sanitized = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return sanitized || 'unnamed';
}

function asArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('MCP tool arguments must be an object');
}

function mcpResultToModelOutput(output: unknown): Extract<ToolResultOutput, { type: 'content' }> {
  const result = output as Partial<McpCallResult>;
  const blocks = Array.isArray(result.content) ? result.content : [];
  const value: ToolResultContentPart[] = [];
  const nonVisual: unknown[] = [];
  let remainingTextChars = MAX_MODEL_TEXT_CHARS;
  let imageChars = 0;
  let imageCount = 0;
  let omittedSummaryBlocks = 0;

  const appendText = (text: string): void => {
    if (remainingTextChars <= 0) return;
    const clipped = clipModelText(text, remainingTextChars);
    remainingTextChars -= clipped.length;
    value.push({ type: 'text', text: clipped });
  };
  const appendSummary = (summary: unknown): void => {
    if (nonVisual.length < MAX_SUMMARIZED_BLOCKS) nonVisual.push(summary);
    else omittedSummaryBlocks += 1;
  };

  for (const block of blocks) {
    if (block.type === 'text') appendText(block.text);
    else if (
      block.type === 'image' &&
      imageCount < MAX_NATIVE_IMAGES &&
      imageChars + block.data.length <= MAX_NATIVE_IMAGE_BASE64_CHARS
    ) {
      value.push({
        type: 'file',
        data: { type: 'data', data: block.data },
        mediaType: block.mimeType,
      });
      imageCount += 1;
      imageChars += block.data.length;
    } else appendSummary(summarizeNonVisualBlock(block));
  }
  if (nonVisual.length || omittedSummaryBlocks || result.structuredContent !== undefined) {
    appendText(
      safeJsonStringify({
        ...(nonVisual.length ? { content: nonVisual } : {}),
        ...(omittedSummaryBlocks ? { omittedContentBlocks: omittedSummaryBlocks } : {}),
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
      }),
    );
  }
  if (value.length === 0) value.push({ type: 'text', text: 'MCP tool completed with no content.' });
  return { type: 'content', value };
}

function summarizeNonVisualBlock(block: McpCallResult['content'][number]): unknown {
  if (block.type === 'audio') {
    return { type: block.type, mimeType: block.mimeType, base64Chars: block.data.length };
  }
  if (block.type === 'resource') {
    return {
      ...block,
      ...(block.text ? { text: clipModelText(block.text, MAX_MODEL_TEXT_CHARS) } : {}),
      ...(block.blob ? { blob: undefined, base64Chars: block.blob.length } : {}),
    };
  }
  if (block.type === 'image') {
    return {
      type: block.type,
      mimeType: block.mimeType,
      base64Chars: block.data.length,
      omitted: 'too_large',
    };
  }
  if (block.type === 'unknown') return { type: block.type, omitted: true };
  return block;
}

function clipModelText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit);
  return `${value.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"content":"MCP output could not be serialized"}';
  }
}
