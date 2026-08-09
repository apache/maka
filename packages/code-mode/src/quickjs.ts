import {
  CodeModeError,
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
import { DEFAULT_CODE_MODE_LIMITS } from './index.js';

export async function executeCodeCellImpl(
  input: ExecuteCodeCellInput,
): Promise<CodeModeExecutionResult> {
  const limits = {
    maxSourceBytes: input.limits?.maxSourceBytes ?? DEFAULT_CODE_MODE_LIMITS.maxSourceBytes,
    maxSandboxTimeMs: input.limits?.maxSandboxTimeMs ?? DEFAULT_CODE_MODE_LIMITS.maxSandboxTimeMs,
    maxMemoryBytes: input.limits?.maxMemoryBytes ?? DEFAULT_CODE_MODE_LIMITS.maxMemoryBytes,
    maxStackBytes: input.limits?.maxStackBytes ?? DEFAULT_CODE_MODE_LIMITS.maxStackBytes,
    maxToolCalls: input.limits?.maxToolCalls ?? DEFAULT_CODE_MODE_LIMITS.maxToolCalls,
    maxToolConcurrency:
      input.limits?.maxToolConcurrency ?? DEFAULT_CODE_MODE_LIMITS.maxToolConcurrency,
    maxToolInputBytes:
      input.limits?.maxToolInputBytes ?? DEFAULT_CODE_MODE_LIMITS.maxToolInputBytes,
    maxToolOutputBytes:
      input.limits?.maxToolOutputBytes ?? DEFAULT_CODE_MODE_LIMITS.maxToolOutputBytes,
    maxOutputBytes: input.limits?.maxOutputBytes ?? DEFAULT_CODE_MODE_LIMITS.maxOutputBytes,
  };
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
      options: {
        executionPolicy: {
          timeoutMs: limits.maxSandboxTimeMs,
          memoryLimitBytes: limits.maxMemoryBytes,
          maxStackSizeBytes: limits.maxStackBytes,
          maxResultBytes: limits.maxOutputBytes,
          maxConsoleOutputBytes: 1,
          maxSourceBytes: limits.maxSourceBytes,
          maxToolInputBytes: limits.maxToolInputBytes,
          maxToolOutputBytes: limits.maxToolOutputBytes,
          maxBridgeRequests: limits.maxToolCalls,
          maxInFlightBridgeRequests: limits.maxToolConcurrency,
        },
      },
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
  if (error instanceof SyntaxError) {
    return { kind: 'parse_error', message };
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
