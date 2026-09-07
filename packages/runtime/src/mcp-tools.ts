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

import { createHash } from 'node:crypto';
import { jsonSchema } from 'ai';
import type { ToolActivityKind } from '@maka/core/events';
import type {
  McpCallResult,
  McpToolBinding,
  McpToolDescriptor,
  McpToolSnapshot,
} from '@maka/core/mcp';
import type { InteractionFormInput, InteractionFormResult } from '@maka/core/interaction';
import type { PermissionMode, ToolCategory } from '@maka/core/permission';
import { truncateUtf16Safe } from '@maka/core/text-sanitize';
import type { ExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { ToolRecoveryMode } from '@maka/core/runtime-event';
import type { ToolResultContentPart, ToolResultOutput } from './model-protocol.js';
import type { MakaTool } from './tool-runtime.js';

const MAX_PROVIDER_TOOL_NAME = 64;
const HASH_CHARS = 10;

function normalizeMcpInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.hasOwn(schema, 'type') ? schema : { ...schema, type: 'object' };
}
const MAX_NATIVE_IMAGE_BASE64_CHARS = 20_000_000;
const MAX_NATIVE_IMAGES = 4;
const MAX_MODEL_TEXT_CHARS = 200_000;
const MAX_SUMMARIZED_BLOCKS = 100;
const TRUNCATION_MARKER = '\n…[truncated by Maka]';

export interface McpToolProvider {
  toolSnapshot(): McpToolSnapshot;
  prepareTool?(
    binding: McpToolBinding,
    args: Record<string, unknown>,
    options: Omit<McpToolCallOptions, 'emitProgress'>,
  ): Promise<McpPreparedToolCall>;
  callTool(
    binding: McpToolBinding,
    args: Record<string, unknown>,
    options: McpToolCallOptions,
  ): Promise<McpCallResult>;
}

export interface McpPreparedToolCall {
  execute(options?: {
    readonly emitProgress?: (current: number, total: number) => void;
    readonly requestInteraction?: McpToolCallOptions['requestInteraction'];
  }): Promise<McpCallResult>;
  cancel(): Promise<void> | void;
}

export interface McpToolCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly context: McpToolInvocationContext;
  readonly emitProgress?: (current: number, total: number) => void;
  readonly requestInteraction?: (
    form: InteractionFormInput,
    options?: { readonly cancellationSignal?: AbortSignal },
  ) => Promise<InteractionFormResult>;
}

export interface McpToolInvocationContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly cwd: string;
  readonly executionBoundary?: ExecutionBoundary;
  readonly permissionMode?: PermissionMode;
}

export interface BuildMcpToolsOptions {
  callTimeoutMs?: number;
  categoryHint?: ToolCategory;
  hostAdmission?: MakaTool['hostAdmission'];
  recoveryMode?: ToolRecoveryMode;
  executionLocation?: 'host' | 'remote';
  activityKindForDescriptor?: (descriptor: McpToolDescriptor) => ToolActivityKind | undefined;
}

export interface McpIdentifiedTool {
  readonly tool: MakaTool;
  readonly serverId: string;
  readonly toolName: string;
}

export function buildMcpTools(
  provider: McpToolProvider,
  options: BuildMcpToolsOptions = {},
): MakaTool[] {
  return buildMcpToolsWithIdentities(provider, options).map(({ tool }) => tool);
}

export function buildMcpToolsWithIdentities(
  provider: McpToolProvider,
  options: BuildMcpToolsOptions = {},
): McpIdentifiedTool[] {
  const names = new Map<string, string>();
  const snapshot = provider.toolSnapshot();
  return snapshot.tools.map(({ descriptor, binding }) => {
    const inputSchema = normalizeMcpInputSchema(descriptor.inputSchema);
    const identity = `${descriptor.serverId}\0${descriptor.name}`;
    const name = mcpProxyToolName(descriptor.serverId, descriptor.name);
    const collision = names.get(name);
    if (collision && collision !== identity) {
      throw new Error(`MCP proxy tool name collision: ${name}`);
    }
    names.set(name, identity);
    return {
      serverId: descriptor.serverId,
      toolName: descriptor.name,
      tool: {
        name,
        description:
          descriptor.description?.trim() ||
          `MCP tool ${descriptor.name} provided by ${descriptor.serverId}`,
        displayName: descriptor.annotations?.title?.trim() || descriptor.name,
        activityKind: options.activityKindForDescriptor?.(descriptor) ?? 'tool',
        // MCP annotations are advisory provider claims, not a security boundary.
        // The trusted composition may select a stricter open-world category;
        // ordinary MCP servers retain the side-effecting network default.
        categoryHint: options.categoryHint ?? 'network_send',
        ...(options.hostAdmission ? { hostAdmission: options.hostAdmission } : {}),
        ...(options.recoveryMode ? { recoveryMode: options.recoveryMode } : {}),
        // The MCP server remains the sole authority for the complete JSON
        // Schema. Runtime only carries the declaration to the AI SDK.
        parameters: jsonSchema(inputSchema),
        ...(provider.prepareTool
          ? {
              prepareExecution: async (args: unknown, context) => {
                const prepared = await provider.prepareTool!(binding, asArguments(args), {
                  signal: context.abortSignal,
                  timeoutMs: options.callTimeoutMs,
                  context: {
                    sessionId: context.sessionId,
                    runId: context.runId,
                    turnId: context.turnId,
                    toolCallId: context.toolCallId,
                    cwd: context.cwd,
                    executionBoundary: context.executionBoundary,
                    permissionMode: context.permissionMode,
                  },
                });
                return {
                  execute: (executionContext) =>
                    prepared.execute({
                      ...(executionContext.emitProgress
                        ? { emitProgress: executionContext.emitProgress }
                        : {}),
                      ...(executionContext.requestUserForm
                        ? {
                            requestInteraction: (form, interactionOptions) =>
                              executionContext.requestUserForm!(form, interactionOptions),
                          }
                        : {}),
                    }),
                  cancel: () => prepared.cancel(),
                };
              },
            }
          : {}),
        impl: async (args: unknown, context) => {
          // Managed network authority applies equally to Direct and nested CodeMode dispatch.
          if (
            options.executionLocation !== 'remote' &&
            context.executionBoundary?.kind === 'managed' &&
            context.executionBoundary.profile.network.kind !== 'enabled'
          ) {
            if (!context.requestSandboxBoundary) {
              throw new Error('MCP network access requires sandbox boundary approval');
            }
            const settlement = await context.requestSandboxBoundary(
              { network: { enabled: true } },
              `Call MCP tool ${descriptor.serverId}/${descriptor.name}.`,
            );
            if (settlement.request.status !== 'approved') {
              throw new Error('MCP network access denied');
            }
          }
          return provider.callTool(binding, asArguments(args), {
            signal: context.abortSignal,
            timeoutMs: options.callTimeoutMs,
            context: {
              sessionId: context.sessionId,
              turnId: context.turnId,
              toolCallId: context.toolCallId,
              cwd: context.cwd,
            },
            ...(context.emitProgress ? { emitProgress: context.emitProgress } : {}),
            ...(context.requestUserForm
              ? {
                  requestInteraction: (
                    form: InteractionFormInput,
                    interactionOptions?: { readonly cancellationSignal?: AbortSignal },
                  ) => context.requestUserForm!(form, interactionOptions),
                }
              : {}),
          });
        },
        toModelOutput: ({ output }) => mcpResultToModelOutput(output),
      } satisfies MakaTool,
    };
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
    return {
      type: block.type,
      mimeType: block.mimeType,
      base64Chars: block.data.length,
    };
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
  // The marker is all-BMP, so slicing it can't split a pair.
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit);
  return `${truncateUtf16Safe(value, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"content":"MCP output could not be serialized"}';
  }
}
