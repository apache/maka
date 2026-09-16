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

import { z } from 'zod';

import type { RepairableAiSdkToolCall } from './model-adapter.js';
import { SandboxCommandError } from './sandbox/errors.js';
import { REQUEST_SANDBOX_BOUNDARY_TOOL_NAME } from './sandbox-boundary-tool.js';
import {
  formatSyntheticToolErrorText,
  formatToolArgsViolationText,
  type MakaTool,
} from './tool-runtime.js';

export const INVALID_TOOL_NAME = 'invalid';

export function repairMakaToolCall(input: {
  toolCall: RepairableAiSdkToolCall;
  availableToolNames: readonly string[];
  error: unknown;
  /** Schema lookup for the tool that was called, when the caller has one. */
  toolParameters?: (toolName: string) => unknown;
  /**
   * Category lookup for the same tool.
   *
   * Computer Use declares one flat wire object standing in for a per-action
   * union, so its schema shape alone names every field of every action.
   */
  toolCategoryHint?: (toolName: string) => string | undefined;
}): RepairableAiSdkToolCall | null {
  const requestedName = input.toolCall.toolName;
  if (requestedName === INVALID_TOOL_NAME) return null;

  const lowerRequestedName = requestedName.toLowerCase();
  const exactLowercaseMatch = input.availableToolNames.find(
    (name) => name.toLowerCase() === lowerRequestedName,
  );
  if (exactLowercaseMatch && exactLowercaseMatch !== requestedName) {
    return { ...input.toolCall, toolName: exactLowercaseMatch };
  }

  return {
    ...input.toolCall,
    toolName: INVALID_TOOL_NAME,
    input: JSON.stringify({
      tool: requestedName,
      error: describeUnrepairableToolCall(input),
      ...(isProviderSandboxBoundaryAttempt(input.toolCall) ? { sandboxBoundaryAttempt: true } : {}),
    }),
  };
}

/**
 * What the model is told about a call that could not be repaired.
 *
 * Two different failures arrive here. A name that matches nothing: the caller
 * is holding the list of names that would have worked and used to drop it,
 * leaving the model with its own wrong name and a validator's complaint — the
 * same dead end `tool-availability` avoids by naming what is available.
 * Arguments the tool's schema rejected: the schema knows which fields the call
 * takes, so say them rather than let the model re-send the shape just refused.
 */
function describeUnrepairableToolCall(input: {
  toolCall: RepairableAiSdkToolCall;
  availableToolNames: readonly string[];
  error: unknown;
  toolParameters?: (toolName: string) => unknown;
  toolCategoryHint?: (toolName: string) => string | undefined;
}): string {
  const requestedName = input.toolCall.toolName;
  const known = input.availableToolNames.includes(requestedName);
  if (!known) {
    const available = input.availableToolNames.join(', ');
    const detail = formatSyntheticToolErrorText(input.error);
    return available ? `${detail} Available tools: ${available}.` : detail;
  }
  return formatToolArgsViolationText({
    toolName: requestedName,
    parameters: input.toolParameters?.(requestedName),
    categoryHint: input.toolCategoryHint?.(requestedName),
    args: parseToolCallInput(input.toolCall.input),
    error: input.error,
  });
}

function parseToolCallInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function isProviderSandboxBoundaryAttempt(toolCall: {
  toolName: string;
  input: unknown;
}): boolean {
  const toolName = toolCall.toolName.toLowerCase();
  if (toolName === REQUEST_SANDBOX_BOUNDARY_TOOL_NAME) return true;
  if (toolName !== 'bash') return false;
  const parsed = parseToolCallInput(toolCall.input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const boundaryIntent = (parsed as Record<string, unknown>).boundary_intent;
  return boundaryIntent !== undefined && boundaryIntent !== 'current';
}

export function buildInvalidMakaTool(): MakaTool<
  { tool?: string; error?: string; sandboxBoundaryAttempt?: true },
  never
> {
  return {
    name: INVALID_TOOL_NAME,
    description:
      'Internal repair target for malformed or unknown tool calls. Do not call directly.',
    parameters: z.object({
      tool: z.string().optional(),
      error: z.string().optional(),
      sandboxBoundaryAttempt: z.literal(true).optional(),
    }),
    impl: ({ tool, error, sandboxBoundaryAttempt }) => {
      const requested = tool ? ` "${tool}"` : '';
      const message = `模型请求了不可用或格式错误的工具${requested}：${error || 'tool call could not be parsed'}`;
      if (sandboxBoundaryAttempt) {
        throw new SandboxCommandError({
          domain: 'command',
          stage: 'validation',
          reason: 'invalid_boundary_declaration',
          recoverable: true,
          message,
        });
      }
      throw new Error(message);
    },
  };
}
