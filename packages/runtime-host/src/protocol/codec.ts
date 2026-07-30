import { invalidProtocolFrame } from './errors.js';

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

export function requireExactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = requireRecord(value, label);
  assertExactKeys(record, label, keys);
  return record;
}

export function assertExactKeys(
  record: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw invalidProtocolFrame(`Unknown ${label} field`);
  }
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw invalidProtocolFrame(`Invalid ${label} fields`);
  }
}

export function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

export function requireId(value: unknown, label: string): string {
  return requireString(value, label, 128);
}

export function requireEntityId(value: unknown, label: string): string {
  const id = requireId(value, label);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw invalidProtocolFrame(`Invalid ${label}`);
  return id;
}

export function requireCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as number;
}
