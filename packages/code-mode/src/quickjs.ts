import {
  CodeModeError,
  type CodeModeExecutionPolicy,
  CodeModeToolError,
  experimental_runCodeMode as runCodeMode,
} from '@ai-sdk/code-mode';
import { jsonSchema, tool, type ToolSet } from 'ai';
import type {
  CodeModeDiagnostic,
  CodeModeExecutionResult,
  CodeModeToolCall,
  ExecuteCodeCellInput,
} from './index.js';
import { DEFAULT_CODE_MODE_EXECUTION_POLICY } from './index.js';

export async function executeCodeCell(
  input: ExecuteCodeCellInput,
): Promise<CodeModeExecutionResult> {
  // An explicit `undefined` override keeps the product default rather than
  // falling through to the SDK's looser one.
  const executionPolicy: CodeModeExecutionPolicy = { ...DEFAULT_CODE_MODE_EXECUTION_POLICY };
  for (const [key, value] of Object.entries(input.executionPolicy ?? {})) {
    if (value !== undefined) (executionPolicy as Record<string, unknown>)[key] = value;
  }
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
