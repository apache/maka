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
  // Validation and identity serialization are deliberately separate. Runtime
  // events need the strict, lossless serializer below; the persisted v1 T1
  // protocol must retain mainline's historical stableHash byte semantics.
  stableJsonStringify(args);
  const body = stringifyMainlineV1ToolArgsIdentity(toolName, args);
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

function stringifyMainlineV1ToolArgsIdentity(toolName: string, args: unknown): string {
  return JSON.stringify(canonicalizeMainlineV1({ toolName, args }));
}

function canonicalizeMainlineV1(value: unknown, parentKey?: string): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeMainlineV1(item));
    return parentKey === 'required' || parentKey === 'enum'
      ? items
          .slice()
          .sort((a, b) =>
            JSON.stringify(canonicalizeMainlineV1(a)).localeCompare(
              JSON.stringify(canonicalizeMainlineV1(b)),
            ),
          )
      : items;
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    // Mainline v1 assigned into a normal object, so this key invoked the
    // legacy Object.prototype setter and was absent from the serialized bytes.
    // Skip it explicitly to freeze those bytes without mutating a prototype.
    if (key === '__proto__') continue;
    result[key] = canonicalizeMainlineV1(record[key], key);
  }
  return result;
}
