import { isDeepStrictEqual } from 'node:util';
import type { RuntimeEvent } from './runtime-event.js';
import { decodeRuntimeEvent } from './runtime-event.js';
import { stableJsonStringify } from './tool-args-identity.js';

export interface CanonicalRuntimeEventEncoding {
  event: RuntimeEvent;
  json: string;
}

/**
 * Owns the one lossless JSON representation used for immutable RuntimeEvents.
 *
 * The structural decoder may intentionally normalize optional presentation
 * fields. After that normalization, every nested value must still be strict
 * JSON: no undefined, accessors, custom prototypes, toJSON hooks, sparse
 * arrays, or other values whose persisted meaning could differ from the value
 * validated by a writer.
 */
export function encodeCanonicalRuntimeEvent(value: unknown): CanonicalRuntimeEventEncoding {
  const decoded = normalizeRuntimeEventEnvelope(decodeRuntimeEvent(value));
  let json: string;
  try {
    json = stableJsonStringify(decoded);
  } catch (cause) {
    throw new Error('RuntimeEvent is not losslessly serializable', { cause });
  }
  const event = decodeRuntimeEvent(JSON.parse(json));
  if (!isDeepStrictEqual(decoded, event)) {
    throw new Error('RuntimeEvent is not losslessly serializable');
  }
  return { event, json };
}

function normalizeRuntimeEventEnvelope(event: RuntimeEvent): RuntimeEvent {
  const normalized = omitUndefinedEnvelopeFields(event) as unknown as RuntimeEvent;
  for (const key of ['content', 'actions', 'refs'] as const) {
    const nested = normalized[key];
    if (nested && typeof nested === 'object') {
      Object.defineProperty(normalized, key, {
        ...Object.getOwnPropertyDescriptor(normalized, key),
        value: omitUndefinedEnvelopeFields(nested),
      });
    }
  }
  return normalized;
}

function omitUndefinedEnvelopeFields(value: object): object {
  const result = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('RuntimeEvent is not losslessly serializable');
    }
    if (descriptor.value === undefined) continue;
    Object.defineProperty(result, key, descriptor);
  }
  return result;
}
