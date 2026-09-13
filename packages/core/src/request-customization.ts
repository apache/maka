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

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export interface JsonArray extends ReadonlyArray<JsonValue> {}
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface SavedRequestHeaders {
  readonly names: readonly string[];
}

export interface RequestHeaderUpdate {
  readonly name: string;
  readonly value?: string;
}

export const REQUEST_HEADERS_MAX_COUNT = 32;
export const REQUEST_HEADER_NAME_MAX_LENGTH = 128;
export const REQUEST_HEADER_VALUE_MAX_LENGTH = 8_192;
export const REQUEST_HEADERS_MAX_BYTES = 64 * 1_024;
export const REQUEST_BODY_OVERLAY_MAX_BYTES = 32 * 1_024;
export const REQUEST_BODY_OVERLAY_MAX_DEPTH = 16;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PROTECTED_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'host',
  'proxy-authorization',
  'transfer-encoding',
  'x-api-key',
]);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class RequestCustomizationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestCustomizationValidationError';
  }
}

export function normalizeRequestHeaders(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new RequestCustomizationValidationError('Request headers must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > REQUEST_HEADERS_MAX_COUNT) {
    throw new RequestCustomizationValidationError(
      `Request headers cannot exceed ${REQUEST_HEADERS_MAX_COUNT} entries`,
    );
  }
  const normalized: Array<readonly [string, string]> = [];
  const names = new Set<string>();
  for (const [rawName, rawValue] of entries) {
    const name = normalizeRequestHeaderName(rawName);
    const lowerName = name.toLowerCase();
    if (names.has(lowerName)) {
      throw new RequestCustomizationValidationError(`Duplicate request header: ${name}`);
    }
    names.add(lowerName);
    normalized.push([name, normalizeRequestHeaderValue(name, rawValue)]);
  }
  const result = Object.fromEntries(normalized);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > REQUEST_HEADERS_MAX_BYTES) {
    throw new RequestCustomizationValidationError(
      `Request headers cannot exceed ${REQUEST_HEADERS_MAX_BYTES} bytes`,
    );
  }
  return result;
}

export function normalizeRequestHeaderUpdates(value: unknown): readonly RequestHeaderUpdate[] {
  if (!Array.isArray(value) || value.length > REQUEST_HEADERS_MAX_COUNT) {
    throw new RequestCustomizationValidationError('Request header updates must be an array');
  }
  const names = new Set<string>();
  return value.map((rawUpdate) => {
    if (!isRecord(rawUpdate)) {
      throw new RequestCustomizationValidationError('Request header update must be an object');
    }
    const keys = Object.keys(rawUpdate);
    if (
      !Object.hasOwn(rawUpdate, 'name') ||
      keys.some((key) => key !== 'name' && key !== 'value')
    ) {
      throw new RequestCustomizationValidationError('Invalid request header update');
    }
    const name = normalizeRequestHeaderName(rawUpdate.name);
    let value: string | undefined;
    if (Object.hasOwn(rawUpdate, 'value')) {
      value = normalizeRequestHeaderValue(name, rawUpdate.value);
    }
    const lowerName = name.toLowerCase();
    if (names.has(lowerName)) {
      throw new RequestCustomizationValidationError(`Duplicate request header: ${name}`);
    }
    names.add(lowerName);
    return value === undefined ? { name } : { name, value };
  });
}

function normalizeRequestHeaderName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new RequestCustomizationValidationError('Invalid request header name');
  }
  const name = value.trim();
  if (
    name.length === 0 ||
    name.length > REQUEST_HEADER_NAME_MAX_LENGTH ||
    !HEADER_NAME.test(name)
  ) {
    throw new RequestCustomizationValidationError(`Invalid request header name: ${value}`);
  }
  if (PROTECTED_HEADERS.has(name.toLowerCase())) {
    throw new RequestCustomizationValidationError(`Request header ${name} is managed by Maka`);
  }
  return name;
}

function normalizeRequestHeaderValue(name: string, value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > REQUEST_HEADER_VALUE_MAX_LENGTH ||
    /[^\t\u0020-\u007e\u0080-\u00ff]/.test(value)
  ) {
    throw new RequestCustomizationValidationError(`Invalid value for request header ${name}`);
  }
  return value;
}

export function serializeRequestHeaders(value: unknown): string {
  return JSON.stringify(normalizeRequestHeaders(value));
}

export function parseRequestHeaders(value: string): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RequestCustomizationValidationError('Stored request headers are not valid JSON');
  }
  return normalizeRequestHeaders(parsed);
}

export function normalizeRequestBodyOverlay(value: unknown): JsonObject {
  if (!isRecord(value)) {
    throw new RequestCustomizationValidationError('Extra request body must be a JSON object');
  }
  const normalized = normalizeJsonObject(value, 1);
  if (
    new TextEncoder().encode(JSON.stringify(normalized)).byteLength > REQUEST_BODY_OVERLAY_MAX_BYTES
  ) {
    throw new RequestCustomizationValidationError(
      `Extra request body cannot exceed ${REQUEST_BODY_OVERLAY_MAX_BYTES} bytes`,
    );
  }
  return normalized;
}

export function normalizeOptionalRequestBodyOverlay(value: unknown): JsonObject | undefined {
  const normalized = normalizeRequestBodyOverlay(value);
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function normalizeJsonObject(value: Record<string, unknown>, depth: number): JsonObject {
  if (depth > REQUEST_BODY_OVERLAY_MAX_DEPTH) {
    throw new RequestCustomizationValidationError(
      `Extra request body cannot exceed ${REQUEST_BODY_OVERLAY_MAX_DEPTH} levels`,
    );
  }
  const sortedEntries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const entries: Array<readonly [string, JsonValue]> = [];
  for (const [key, child] of sortedEntries) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      throw new RequestCustomizationValidationError(`Extra request body key ${key} is not allowed`);
    }
    entries.push([key, normalizeJsonValue(child, depth + 1)]);
  }
  return Object.fromEntries(entries);
}

function normalizeJsonValue(value: unknown, depth: number): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new RequestCustomizationValidationError('Extra request body numbers must be finite');
  }
  if (depth > REQUEST_BODY_OVERLAY_MAX_DEPTH) {
    throw new RequestCustomizationValidationError(
      `Extra request body cannot exceed ${REQUEST_BODY_OVERLAY_MAX_DEPTH} levels`,
    );
  }
  if (Array.isArray(value)) return value.map((child) => normalizeJsonValue(child, depth + 1));
  if (isRecord(value)) return normalizeJsonObject(value, depth);
  throw new RequestCustomizationValidationError('Extra request body must contain only JSON values');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
