import type { Revision } from '@maka/core/runtime-policy';
import { codecError, type CodecSource } from './errors.js';

export function record(
  value: unknown,
  context: string,
  source: CodecSource,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw codecError(source, `${context} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw codecError(source, `${context} must be a plain object`);
  }
  const candidate = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(candidate)) {
    if (!allowedSet.has(key))
      throw codecError(source, `${context} contains unknown field '${key}'`);
  }
  for (const key of required) {
    if (!Object.hasOwn(candidate, key)) throw codecError(source, `${context} is missing '${key}'`);
  }
  return candidate;
}

export function revision(value: unknown, context: string, source: CodecSource): Revision {
  return integer(value, context, 0, Number.MAX_SAFE_INTEGER, source);
}

export function integer(
  value: unknown,
  context: string,
  min: number,
  max: number,
  source: CodecSource,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw codecError(source, `${context} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

export function unique(values: readonly string[], context: string, source: CodecSource): void {
  if (new Set(values).size !== values.length) {
    throw codecError(source, `${context} values must be unique`);
  }
}

export function nextRevision(value: Revision): Revision {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw codecError('invalid_document', 'Revision space is exhausted');
  }
  return value + 1;
}

export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
