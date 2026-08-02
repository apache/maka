import * as nodeCrypto from 'node:crypto';

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
  return `sha256:${nodeCrypto.createHash('sha256').update(body).digest('hex')}`;
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

/**
 * The same value with every `undefined`-valued property removed.
 *
 * Provider metadata is handed to Maka as the SDK parsed it, and a field the
 * response did not carry arrives as an explicit `undefined` — Anthropic's
 * `caller` object comes through as `{ type: 'direct', toolId: undefined }` when
 * there is no tool id. JSON drops such a property, so the value no longer
 * round-trips, and `encodeCanonicalRuntimeEvent` refuses it. That refusal is
 * correct: an immutable event must mean the same thing after it is read back.
 *
 * The cost of not doing this was total. The refused write marked the runtime
 * event store unavailable, the turn's terminal write then threw, and every turn
 * that called any tool died a tenth of a second after the tool returned —
 * `load_tools` succeeded, reported the group loaded, and the turn ended there.
 *
 * Dropping the key is lossless in the only sense that matters: JSON cannot tell
 * an absent property from one set to `undefined`, so this writes down what
 * would have been persisted anyway. The same reasoning gives an array hole a
 * `null` rather than a removal — JSON writes one there regardless, and removing
 * the entry would shift everything after it.
 *
 * What it does not do: it never rebuilds a value that needed no change, so
 * symbol keys, getters and object identity survive untouched on that path; a
 * value it does rebuild is a plain-object spread, which keeps symbol keys and
 * loses nothing JSON could have seen. Anything with its own prototype is
 * returned as-is rather than flattened.
 */
export function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    // An array hole is not a property that can be dropped: JSON writes it as
    // `null`, so leaving `undefined` in place produces a value that does not
    // round-trip and the encoder refuses it just the same. Writing `null` is
    // not inventing a value — it is writing down what would be persisted.
    const mapped = value.map((entry) => (entry === undefined ? null : stripUndefinedDeep(entry)));
    return (mapped.some((entry, index) => entry !== value[index]) ? mapped : value) as unknown as T;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  let changed = false;
  const out: Record<string, unknown> = { ...record };
  for (const key of keys) {
    const entry = record[key];
    if (entry === undefined) {
      delete out[key];
      changed = true;
      continue;
    }
    const next = stripUndefinedDeep(entry);
    if (next !== entry) {
      out[key] = next;
      changed = true;
    }
  }
  // Unchanged values are returned as they came. Rebuilding one that needed
  // nothing would drop symbol keys and re-run getters for no gain, and the
  // common case by far is that nothing needs removing.
  return (changed ? out : value) as unknown as T;
}
