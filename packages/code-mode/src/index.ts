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

export { executeCodeCell } from './quickjs.js';
