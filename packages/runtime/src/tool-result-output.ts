import type { JSONValue, ToolResultOutput } from './model-protocol.js';

/**
 * Coerce an arbitrary tool result into a JSON-safe value (non-JSON scalars are
 * stringified). Used to satisfy the `{type:'json'|'error-json', value}` arms.
 */
export function jsonValue(value: unknown): JSONValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    Array.isArray(value) ||
    typeof value === 'object'
  ) {
    return value as JSONValue;
  }
  return String(value);
}

/**
 * Wrap a raw tool result as canonical provider-facing tool output, choosing the
 * text vs json arm by value type and the error vs success arm by `isError`.
 */
export function toolResultOutput(value: unknown, isError: boolean): ToolResultOutput {
  if (isError) {
    return typeof value === 'string'
      ? { type: 'error-text', value }
      : { type: 'error-json', value: jsonValue(value) };
  }
  return typeof value === 'string'
    ? { type: 'text', value }
    : { type: 'json', value: jsonValue(value) };
}
