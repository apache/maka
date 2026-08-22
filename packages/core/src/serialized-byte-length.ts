/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * The single serialized-byte fact for the repository: how many UTF-8 bytes the
 * JSON representation of a value occupies, including quotes and escapes. Used
 * wherever a payload is bounded before it is persisted or published.
 *
 * Counting stops as soon as `maxBytes` is exceeded, so callers can bound
 * untrusted input without materializing it. Values JSON cannot faithfully
 * represent (a circular reference, a `toJSON` hook, a non-plain prototype)
 * report `Number.POSITIVE_INFINITY` rather than a count.
 *
 * One deliberate departure from `JSON.stringify`, which returns `undefined`
 * for a top-level `undefined`: that case is counted as four bytes rather than
 * reported as unrepresentable. An absent result is not an oversized one, and
 * four bytes is a conservative bound on what callers publish in its place — a
 * Code Mode cell substitutes `null` through `value ?? null`, and a tool result
 * becomes empty text through result-content coercion. Reporting infinity would
 * make a tool that simply returned nothing fail its result-byte bound as though
 * the result were too large.
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
