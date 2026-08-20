import type { CodeModeExecutionPolicy } from '@ai-sdk/code-mode';

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
  executionPolicy?: CodeModeExecutionPolicy;
}

interface QueuedCodeCell {
  input: ExecuteCodeCellInput;
  resolve: (result: CodeModeExecutionResult) => void;
  reject: (error: unknown) => void;
  onAbort?: () => void;
}

/**
 * Admission for a Code Mode cell, held across its complete lifecycle — through
 * the host-operation drain that follows `runCodeMode`, not just the sandbox run.
 *
 * The SDK's worker cap cannot stand in for this. On cancellation `runCodeMode`
 * releases its worker slot and rejects at once, by design, while host operations
 * started from the cell may still be running with durable side effects. Only
 * Maka waits for those, so only Maka can bound how many cells are outstanding.
 * Releasing admission when the worker is released would let repeated
 * cancellation accumulate host work without bound.
 */
let queuedCodeCell: QueuedCodeCell | undefined;
let codeCellActive = false;

export async function executeCodeCell(
  input: ExecuteCodeCellInput,
): Promise<CodeModeExecutionResult> {
  if (input.signal?.aborted) throw input.signal.reason ?? abortError();
  return new Promise<CodeModeExecutionResult>((resolve, reject) => {
    const entry: QueuedCodeCell = { input, resolve, reject };
    if (codeCellActive) {
      if (queuedCodeCell) {
        resolve({
          ok: false,
          error: { kind: 'limit_exceeded', message: 'Code Mode execution queue is full' },
          toolCalls: [],
        });
        return;
      }
      const onAbort = () => {
        if (queuedCodeCell !== entry) return;
        queuedCodeCell = undefined;
        reject(input.signal?.reason ?? abortError());
      };
      entry.onAbort = onAbort;
      input.signal?.addEventListener('abort', onAbort, { once: true });
      queuedCodeCell = entry;
      return;
    }
    codeCellActive = true;
    runCodeCell(entry);
  });
}

function runCodeCell(entry: QueuedCodeCell): void {
  if (entry.onAbort) entry.input.signal?.removeEventListener('abort', entry.onAbort);
  void executeCodeCellImpl(entry.input)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      const next = queuedCodeCell;
      queuedCodeCell = undefined;
      if (next) runCodeCell(next);
      else codeCellActive = false;
    });
}

function abortError(): Error {
  const error = new Error('Code Mode cell aborted');
  error.name = 'AbortError';
  return error;
}
import { executeCodeCellImpl } from './quickjs.js';
