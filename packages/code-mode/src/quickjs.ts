import {
  CodeModeError,
  CodeModeToolError,
  experimental_runCodeMode as runCodeMode,
  experimental_setMaxWorkers as setMaxWorkers,
} from '@ai-sdk/code-mode';
import { jsonSchema, tool, type ToolSet } from 'ai';
import type {
  CodeModeDiagnostic,
  CodeModeExecutionResult,
  CodeModeToolCall,
  ExecuteCodeCellInput,
} from './index.js';
import { DEFAULT_CODE_MODE_LIMITS } from './index.js';

setMaxWorkers(1);

export async function executeCodeCellImpl(
  input: ExecuteCodeCellInput,
): Promise<CodeModeExecutionResult> {
  const limits = { ...DEFAULT_CODE_MODE_LIMITS, ...input.limits };
  const toolCalls: CodeModeToolCall[] = [];
  const hostToolOperations = new Set<Promise<unknown>>();
  let hasFatalToolError = false;
  let fatalToolError: unknown;
  const tools: ToolSet = Object.fromEntries(
    input.tools.map(({ name }) => [
      name,
      tool({
        inputSchema: jsonSchema({}),
        execute: async (toolInput, options) => {
          toolCalls.push({ index: toolCalls.length + 1, name });
          const operation = Promise.resolve().then(() =>
            input.callTool(name, toolInput, options.abortSignal ?? NEVER_ABORTED_SIGNAL),
          );
          hostToolOperations.add(operation);
          void operation.then(
            () => hostToolOperations.delete(operation),
            (error) => {
              hostToolOperations.delete(operation);
              if (input.isFatalToolError?.(error)) {
                hasFatalToolError = true;
                fatalToolError = error;
              }
            },
          );
          return operation.catch((error) => {
            if (input.isFatalToolError?.(error)) throw error;
            throw new CodeModeToolError(error instanceof Error ? error.message : String(error), {
              toolName: name,
            });
          });
        },
      }),
    ]),
  );

  try {
    const value = await runCodeMode({
      js: input.code,
      tools,
      toolExecutionOptions: input.signal ? { abortSignal: input.signal } : undefined,
      options: {
        executionPolicy: {
          timeoutMs: limits.maxWallTimeMs,
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
    if (hasFatalToolError) throw fatalToolError;
    return { ok: true, value: value ?? null, toolCalls };
  } catch (error) {
    await drainHostToolOperations(hostToolOperations);
    if (hasFatalToolError) throw fatalToolError;
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    return {
      ok: false,
      error: normalizeQuickJsError(error),
      toolCalls,
    };
  }
}

const NEVER_ABORTED_SIGNAL = new AbortController().signal;

async function drainHostToolOperations(operations: ReadonlySet<Promise<unknown>>): Promise<void> {
  while (operations.size > 0) await Promise.allSettled([...operations]);
}

function normalizeQuickJsError(error: unknown): CodeModeDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SyntaxError || (error instanceof Error && error.name === 'SyntaxError')) {
    return { kind: 'parse_error', message };
  }
  if (
    /^interrupted$/i.test(message) ||
    /out of memory|stack (?:size|overflow)|call stack/i.test(message) ||
    /exceeds? the \d+ byte size limit/i.test(message) ||
    /bridge request limit/i.test(message)
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
    if (error.code === 'CODE_MODE_TOOL_ERROR' && /^Unknown tool:/i.test(message)) {
      return { kind: 'unknown_tool', message };
    }
    if (error.code === 'CODE_MODE_TOOL_ERROR') return { kind: 'tool_failure', message };
  }
  return { kind: 'execution_error', message };
}
