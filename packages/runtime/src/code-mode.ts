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

// packages/runtime/src/code-mode.ts
// Integration glue over `@ai-sdk/code-mode`: the product execution policy, the
// result shapes the backend publishes, and the adapter that bridges sandbox
// tool calls onto host tools and waits for them to drain.

import {
  CodeModeError,
  type CodeModeExecutionPolicy,
  CodeModeToolError,
  experimental_runCodeMode as runCodeMode,
} from '@ai-sdk/code-mode';
import { jsonSchema, tool, type ToolSet } from 'ai';

export interface CodeModeToolDefinition {
  name: string;
}

/**
 * Product limits for a Code Mode cell, expressed in the SDK's own policy shape.
 * The SDK applies looser defaults; these are the values Maka ships.
 */
export const DEFAULT_CODE_MODE_EXECUTION_POLICY: Readonly<Required<CodeModeExecutionPolicy>> =
  Object.freeze({
    /** Sandbox invocation deadline; aborted host operations still drain before settlement. */
    timeoutMs: 30_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    maxStackSizeBytes: 2 * 1024 * 1024,
    maxResultBytes: 1024 * 1024,
    maxConsoleOutputBytes: 1,
    maxSourceBytes: 64 * 1024,
    maxToolInputBytes: 1024 * 1024,
    maxToolOutputBytes: 1024 * 1024,
    maxBridgeRequests: 32,
    maxInFlightBridgeRequests: 8,
  });

export type CodeModeDiagnosticKind =
  | 'parse_error'
  | 'execution_error'
  | 'unknown_tool'
  | 'limit_exceeded'
  | 'tool_failure';

export interface CodeModeDiagnostic {
  kind: CodeModeDiagnosticKind;
  message: string;
}

export interface CodeModeToolCall {
  index: number;
  name: string;
}

export interface CodeModeExecutionSuccess {
  ok: true;
  value: unknown;
  toolCalls: CodeModeToolCall[];
}

export interface CodeModeExecutionFailure {
  ok: false;
  error: CodeModeDiagnostic;
  toolCalls: CodeModeToolCall[];
}

export type CodeModeExecutionResult = CodeModeExecutionSuccess | CodeModeExecutionFailure;

export interface ExecuteCodeCellInput {
  code: string;
  tools: readonly CodeModeToolDefinition[];
  callTool(name: string, input: unknown, signal: AbortSignal): Promise<unknown>;
  isFatalToolError?: (error: unknown) => boolean;
  signal?: AbortSignal;
  /**
   * The complete policy for this cell. Production omits it, so the frozen
   * product default is the only policy Maka ships; tests pass a whole policy to
   * reach a limit they cannot practically hit at its default, such as the 30s
   * deadline or a megabyte-scale byte cap.
   *
   * There is deliberately no per-field merge. The SDK resolves its own policy
   * with `??` and skips a check outright for an integer above its
   * `2_147_483_647` ceiling, so a partial override is a way to widen a product
   * limit while appearing to tighten one.
   */
  executionPolicy?: Readonly<Required<CodeModeExecutionPolicy>>;
}

/**
 * Runs one Code Mode cell to quiescence.
 *
 * The returned promise settles only after every host operation the cell started
 * has settled, on both the success and the failure path. That is the contract
 * the backend's `codeCellAdmission` limiter depends on; the comment at its call
 * site explains why the sandbox worker cap cannot stand in for it.
 *
 * This module holds no cross-cell state. Bounding how many cells run at once
 * belongs to whoever owns execution, not to this adapter.
 */
export async function executeCodeCell(
  input: ExecuteCodeCellInput,
): Promise<CodeModeExecutionResult> {
  const executionPolicy = input.executionPolicy ?? DEFAULT_CODE_MODE_EXECUTION_POLICY;
  const toolCalls: CodeModeToolCall[] = [];
  const hostToolOperations = new Set<Promise<unknown>>();
  const fatalAbortController = new AbortController();
  const invocationSignal = input.signal
    ? AbortSignal.any([input.signal, fatalAbortController.signal])
    : fatalAbortController.signal;
  let fatalToolFailure: { reason: unknown } | undefined;
  const tools = Object.create(null) as ToolSet;
  for (const { name } of input.tools) {
    tools[name] = tool({
      inputSchema: jsonSchema({}),
      execute: async (toolInput, options) => {
        if (fatalToolFailure) throw fatalToolFailure.reason;
        toolCalls.push({ index: toolCalls.length + 1, name });
        const operation = Promise.resolve().then(() =>
          input.callTool(name, toolInput, options.abortSignal ?? invocationSignal),
        );
        hostToolOperations.add(operation);
        return operation.then(
          (value) => {
            hostToolOperations.delete(operation);
            return value;
          },
          (error) => {
            hostToolOperations.delete(operation);
            if (input.isFatalToolError?.(error)) {
              if (!fatalToolFailure) {
                fatalToolFailure = { reason: error };
                fatalAbortController.abort(error);
              }
              throw error;
            }
            throw new CodeModeToolError(error instanceof Error ? error.message : String(error), {
              toolName: name,
            });
          },
        );
      },
    });
  }

  try {
    const value = await runCodeMode({
      js: input.code,
      tools,
      toolExecutionOptions: { abortSignal: invocationSignal },
      options: { executionPolicy },
    });
    await drainHostToolOperations(hostToolOperations);
    if (fatalToolFailure) throw fatalToolFailure.reason;
    return { ok: true, value: value ?? null, toolCalls };
  } catch (error) {
    await drainHostToolOperations(hostToolOperations);
    if (fatalToolFailure) throw fatalToolFailure.reason;
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    return {
      ok: false,
      error: normalizeQuickJsError(error),
      toolCalls,
    };
  }
}

async function drainHostToolOperations(operations: ReadonlySet<Promise<unknown>>): Promise<void> {
  while (operations.size > 0) await Promise.allSettled([...operations]);
}

function normalizeQuickJsError(error: unknown): CodeModeDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const isRunError =
    error instanceof Error && (error as Error & { code?: unknown }).code === 'RUN_ERROR';
  const isSourceSyntaxRunError =
    isRunError &&
    error.name === 'SyntaxError' &&
    /\n\s+at code-mode\.js:\d+:\d+\s*$/.test(error.stack ?? '');
  if (error instanceof SyntaxError || isSourceSyntaxRunError) {
    return { kind: 'parse_error', message };
  }
  if (
    isRunError &&
    error.name === 'InternalError' &&
    (/^interrupted$/i.test(message) || /out of memory|stack (?:size|overflow)/i.test(message))
  ) {
    return { kind: 'limit_exceeded', message };
  }
  if (error instanceof CodeModeError) {
    if (
      error.code === 'CODE_MODE_TIMEOUT' ||
      error.code === 'CODE_MODE_CONCURRENCY_LIMIT' ||
      error.code === 'CODE_MODE_SOURCE_TOO_LARGE' ||
      error.code === 'CODE_MODE_BRIDGE_LIMIT'
    ) {
      return { kind: 'limit_exceeded', message };
    }
    if (error.code === 'CODE_MODE_SERIALIZATION_ERROR') {
      return {
        kind: /exceeds? the \d+ byte size limit/i.test(message) ? 'limit_exceeded' : 'tool_failure',
        message,
      };
    }
    if (error.code === 'CODE_MODE_TOOL_ERROR' && /^Unknown tool:/i.test(message)) {
      return { kind: 'unknown_tool', message };
    }
    if (error.code === 'CODE_MODE_TOOL_ERROR') return { kind: 'tool_failure', message };
    if (
      error.name === 'InternalError' &&
      (/^interrupted$/i.test(message) || /out of memory|stack (?:size|overflow)/i.test(message))
    ) {
      return { kind: 'limit_exceeded', message };
    }
  }
  return { kind: 'execution_error', message };
}
