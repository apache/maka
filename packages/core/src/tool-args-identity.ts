import { createHash } from 'node:crypto';

/**
 * Returns the identity of the exact provider-visible tool name and arguments.
 *
 * `t1_after_preflight_v1` already persists the mainline identity bytes for
 * stableHash({ toolName, args }). Keep that wire identity stable while using
 * strict JSON canonicalization to reject values that mainline would otherwise
 * coerce ambiguously. A different hash domain requires a versioned dispatch
 * protocol rather than an in-place change to this function.
 *
 * Only JSON values are accepted. Silently coercing `undefined`, bigint, Date,
 * non-finite numbers, accessors, or custom prototypes would create collisions
 * between arguments that the provider/runtime did not actually agree on.
 */
export function canonicalToolArgsHash(toolName: string, args: unknown): `sha256:${string}` {
  if (toolName.length === 0) throw new Error('Tool argument identity requires a tool name');
  const body = stableJsonStringify({
    toolName,
    args,
  });
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeStrictJson(value));
}

function canonicalizeStrictJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Tool arguments must be strict JSON values');
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error('Tool arguments must be strict JSON values');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== value.length + 1 ||
      ownKeys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'length' && !isCanonicalArrayIndex(key, value.length)),
      )
    ) {
      throw new Error('Tool arguments must be strict JSON values');
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('Tool arguments must be strict JSON values');
      }
      result.push(canonicalizeStrictJson(descriptor.value));
    }
    return result;
  }
  if (typeof value !== 'object') throw new Error('Tool arguments must be strict JSON values');

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Tool arguments must be strict JSON values');
  }
  const record = value as Record<string, unknown>;
  // A null prototype keeps JSON property names such as "__proto__" as data.
  // Assigning that key to a normal object would invoke Object.prototype's
  // legacy setter and collapse distinct provider arguments to the same hash.
  const result = Object.create(null) as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    Reflect.ownKeys(record).some(
      (key) => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(record, key)?.enumerable,
    )
  ) {
    throw new Error('Tool arguments must be strict JSON values');
  }
  for (const key of keys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('Tool arguments must be strict JSON values');
    }
    result[key] = canonicalizeStrictJson(descriptor.value);
  }
  return result;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}
