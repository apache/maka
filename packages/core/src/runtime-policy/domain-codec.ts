import type { EntityId, Revision } from '../runtime-policy.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RuntimePolicyDomainDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimePolicyDomainDecodeError';
  }
}

export function exactRecord(
  value: unknown,
  context: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw domainError(`${context} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw domainError(`${context} must be a plain object`);
  }
  const item = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(item)) {
    if (!allowedSet.has(key)) throw domainError(`${context} contains unknown field '${key}'`);
  }
  for (const key of required) {
    if (!Object.hasOwn(item, key)) throw domainError(`${context} is missing '${key}'`);
  }
  return item;
}

export function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') throw domainError(`${context} must be a boolean`);
  return value;
}

export function integerValue(value: unknown, context: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw domainError(`${context} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

export function revisionValue(value: unknown, context: string): Revision {
  return integerValue(value, context, 0, Number.MAX_SAFE_INTEGER);
}

export function positiveRevisionValue(value: unknown, context: string): Revision {
  return integerValue(value, context, 1, Number.MAX_SAFE_INTEGER);
}

export function stringValue(value: unknown, context: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw domainError(`${context} must be a string no longer than ${maxLength} characters`);
  }
  return value;
}

export function nonEmptyStringValue(value: unknown, context: string, maxLength: number): string {
  const parsed = stringValue(value, context, maxLength);
  if (parsed.length === 0) throw domainError(`${context} must not be empty`);
  return parsed;
}

export function stringArrayValue(value: unknown, context: string, maxEntries: number): string[] {
  if (!Array.isArray(value) || value.length > maxEntries) {
    throw domainError(`${context} must be a bounded string array`);
  }
  const parsed = value.map((item, index) => nonEmptyStringValue(item, `${context}[${index}]`, 512));
  if (new Set(parsed).size !== parsed.length) {
    throw domainError(`${context} values must be unique`);
  }
  return parsed;
}

export function entityIdValue(value: unknown, context: string): EntityId {
  const parsed = nonEmptyStringValue(value, context, 64);
  if (!UUID_PATTERN.test(parsed)) throw domainError(`${context} must be a UUID`);
  return parsed;
}

export function decodeRuntimePolicyEntityId(value: unknown): EntityId {
  return entityIdValue(value, 'runtime policy entity id');
}

export function assertCanonicalValue(original: unknown, canonical: unknown, context: string): void {
  if (!sameValue(original, canonical)) throw domainError(`${context} must be canonical`);
}

export function domainError(message: string): RuntimePolicyDomainDecodeError {
  return new RuntimePolicyDomainDecodeError(message);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]),
    )
  );
}
