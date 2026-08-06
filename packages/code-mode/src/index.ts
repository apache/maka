export interface CodeModeToolDefinition {
  name: string;
}

/**
 * The byte definition shared by the interpreter and Runtime's nested-result
 * publication boundary. JSON is the representation that is persisted and
 * returned to the cell, including quotes and escapes for strings.
 */
export function serializedByteLength(value: unknown, maxBytes = Number.POSITIVE_INFINITY): number {
  const limit =
    Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : Number.POSITIVE_INFINITY;
  const budget: SerializedByteBudget = { bytes: 0, limit, seen: new Set() };
  try {
    if (!countSerializedValue(value, budget, 'top')) return Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return budget.bytes;
}

interface SerializedByteBudget {
  bytes: number;
  limit: number;
  seen: Set<object>;
}

function countSerializedValue(
  value: unknown,
  budget: SerializedByteBudget,
  position: 'top' | 'array' | 'object',
): boolean {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    if (position === 'object') return false;
    if (position === 'top' && value !== undefined) return false;
    addSerializedBytes(budget, 4);
    return true;
  }
  if (value === null) {
    addSerializedBytes(budget, 4);
    return true;
  }
  if (typeof value === 'string') {
    countJsonString(value, budget);
    return true;
  }
  if (typeof value === 'boolean') {
    addSerializedBytes(budget, value ? 4 : 5);
    return true;
  }
  if (typeof value === 'number') {
    const encoded = Number.isFinite(value) ? JSON.stringify(value) : 'null';
    addSerializedBytes(budget, encoded.length);
    return true;
  }
  if (typeof value === 'bigint' || typeof value !== 'object') return false;
  if (budget.seen.has(value)) return false;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }

  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (!addSerializedBytes(budget, 1)) return true;
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0 && !addSerializedBytes(budget, 1)) return true;
        if (!countSerializedValue(value[index], budget, 'array')) return false;
        if (budget.bytes > budget.limit) return true;
      }
      addSerializedBytes(budget, 1);
      return true;
    }

    if (!addSerializedBytes(budget, 1)) return true;
    let emitted = 0;
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      if (emitted > 0 && !addSerializedBytes(budget, 1)) return true;
      if (!countJsonString(key, budget)) return true;
      if (!addSerializedBytes(budget, 1)) return true;
      if (!countSerializedValue(item, budget, 'object')) return false;
      emitted += 1;
      if (budget.bytes > budget.limit) return true;
    }
    addSerializedBytes(budget, 1);
    return true;
  } finally {
    budget.seen.delete(value);
  }
}

function countJsonString(value: string, budget: SerializedByteBudget): boolean {
  if (!addSerializedBytes(budget, 1)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let bytes: number;
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes = 2;
    } else if (code <= 0x1f) {
      bytes = 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes = 4;
        index += 1;
      } else {
        bytes = 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes = 6;
    } else if (code <= 0x7f) {
      bytes = 1;
    } else if (code <= 0x7ff) {
      bytes = 2;
    } else {
      bytes = 3;
    }
    if (!addSerializedBytes(budget, bytes)) return false;
  }
  return addSerializedBytes(budget, 1);
}

function addSerializedBytes(budget: SerializedByteBudget, bytes: number): boolean {
  if (budget.bytes > Number.MAX_SAFE_INTEGER - bytes) {
    budget.bytes = Number.POSITIVE_INFINITY;
    return false;
  }
  if (budget.bytes + bytes > budget.limit) {
    budget.bytes =
      budget.limit < Number.MAX_SAFE_INTEGER ? budget.limit + 1 : Number.POSITIVE_INFINITY;
    return false;
  }
  budget.bytes += bytes;
  return true;
}

export interface CodeModeLimits {
  maxSourceBytes: number;
  maxSteps: number;
  maxWallTimeMs: number;
  maxToolCalls: number;
  maxConcurrency: number;
  maxIntermediateBytes: number;
  maxCollectionItems: number;
  maxResultBytes: number;
  maxOutputBytes: number;
  maxDataDepth: number;
}

export const DEFAULT_CODE_MODE_LIMITS: Readonly<CodeModeLimits> = Object.freeze({
  maxSourceBytes: 64 * 1024,
  maxSteps: 100_000,
  maxWallTimeMs: 30_000,
  maxToolCalls: 32,
  maxConcurrency: 8,
  maxIntermediateBytes: 1024 * 1024,
  maxCollectionItems: 100_000,
  maxResultBytes: 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxDataDepth: 32,
});

export type CodeModeDiagnosticKind =
  | 'parse_error'
  | 'unsupported_syntax'
  | 'execution_error'
  | 'unknown_tool'
  | 'invalid_data'
  | 'limit_exceeded'
  | 'tool_failure';

export interface CodeModeDiagnostic {
  kind: CodeModeDiagnosticKind;
  message: string;
  location?: { line: number; column: number };
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
  limits?: Partial<CodeModeLimits>;
}

export async function executeCodeCell(
  input: ExecuteCodeCellInput,
): Promise<CodeModeExecutionResult> {
  return executeCodeCellImpl(input);
}
import { executeCodeCellImpl } from './interpreter.js';
