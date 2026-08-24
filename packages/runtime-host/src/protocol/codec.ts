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

import { invalidProtocolFrame } from './errors.js';

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

export function requireShapedRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  const record = requireRecord(value, label);
  assertAllowedKeys(record, label, [...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key))) {
    throw invalidProtocolFrame(`Invalid ${label} fields`);
  }
  return record;
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

export function requireUtf8String(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

export function assertAllowedKeys(
  record: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw invalidProtocolFrame(`Unknown ${label} field`);
  }
}

export function requireEncodedByteLimit(value: unknown, label: string, maxBytes: number): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  if (encoded === undefined) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`${label} exceeds byte limit`);
  }
}
