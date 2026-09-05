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

import * as nodeUtil from 'node:util';
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
  if (!nodeUtil.isDeepStrictEqual(decoded, event)) {
    throw new Error('RuntimeEvent is not losslessly serializable');
  }
  return { event, json };
}

function normalizeRuntimeEventEnvelope(event: RuntimeEvent): RuntimeEvent {
  const normalized = omitUndefinedEnvelopeFields(event) as unknown as RuntimeEvent;
  for (const key of ['content', 'refs'] as const) {
    const nested = normalized[key];
    if (nested && typeof nested === 'object') {
      replaceDataProperty(normalized, key, omitUndefinedEnvelopeFields(nested));
    }
  }
  if (normalized.actions && typeof normalized.actions === 'object') {
    replaceDataProperty(normalized, 'actions', normalizeRuntimeEventActions(normalized.actions));
  }
  return normalized;
}

function normalizeRuntimeEventActions(value: object): object {
  const normalized = omitUndefinedEnvelopeFields(value);
  const tokenUsage = Reflect.get(normalized, 'tokenUsage') as unknown;
  if (tokenUsage && typeof tokenUsage === 'object' && !Array.isArray(tokenUsage)) {
    replaceDataProperty(normalized, 'tokenUsage', normalizeTokenUsage(tokenUsage));
  }
  return normalized;
}

function normalizeTokenUsage(value: object): object {
  const normalized = omitUndefinedEnvelopeFields(value);
  const promptSegments = Reflect.get(normalized, 'promptSegments') as unknown;
  if (Array.isArray(promptSegments)) {
    replaceDataProperty(
      normalized,
      'promptSegments',
      mapArrayElements(promptSegments, omitUndefinedEnvelopeFields),
    );
  }
  const contextBudget = Reflect.get(normalized, 'contextBudget') as unknown;
  if (contextBudget && typeof contextBudget === 'object' && !Array.isArray(contextBudget)) {
    replaceDataProperty(normalized, 'contextBudget', normalizeContextBudget(contextBudget));
  }
  return normalized;
}

function normalizeContextBudget(value: object): object {
  const normalized = omitUndefinedEnvelopeFields(value);
  const compactionDecisions = Reflect.get(normalized, 'compactionDecisions') as unknown;
  if (Array.isArray(compactionDecisions)) {
    replaceDataProperty(
      normalized,
      'compactionDecisions',
      mapArrayElements(compactionDecisions, omitUndefinedEnvelopeFields),
    );
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

function mapArrayElements(value: unknown[], map: (item: object) => object): unknown[] {
  const result: unknown[] = [];
  Object.setPrototypeOf(result, Object.getPrototypeOf(value));
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) {
    throw new Error('RuntimeEvent is not losslessly serializable');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('RuntimeEvent is not losslessly serializable');
    }
    const item = descriptor.value;
    Object.defineProperty(result, key, {
      ...descriptor,
      value:
        isArrayIndex(key, value.length) &&
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item)
          ? map(item)
          : item,
    });
  }
  Object.defineProperty(result, 'length', lengthDescriptor);
  return result;
}

function isArrayIndex(key: PropertyKey, length: number): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function replaceDataProperty(target: object, key: PropertyKey, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new Error('RuntimeEvent is not losslessly serializable');
  }
  Object.defineProperty(target, key, { ...descriptor, value });
}
