#!/usr/bin/env node
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
// Keep transport causality without serializing arbitrary payloads or stacks.
// Bounds apply to diagnostics only; they never change dispatch or retry behavior.
export function diagnosticError(error) {
  const seen = new Set();
  function read(value, key) {
    try {
      return value[key];
    } catch {
      return '[unreadable property]';
    }
  }
  function scalar(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'object' || typeof value === 'function') return '[non-scalar property]';
    const text = String(value);
    return text.length > 4096 ? `${text.slice(0, 4096)}[truncated]` : text;
  }
  function encode(value, depth) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return { name: typeof value, message: scalar(value) ?? String(value), code: null };
    }
    if (seen.has(value)) return { message: '[circular error cause]', code: null };
    if (depth >= 8) return { message: '[error cause depth limit]', code: null };
    seen.add(value);
    const result = {
      name: scalar(read(value, 'name')) ?? 'Error',
      message: scalar(read(value, 'message')) ?? 'Unknown error',
      code: scalar(read(value, 'code')),
    };
    for (const key of ['operation', 'mode', 'dispatch', 'reason', 'retryable']) {
      const field = read(value, key);
      if (field !== undefined) result[key] = scalar(field);
    }
    const cause = read(value, 'cause');
    if (cause !== undefined) result.cause = encode(cause, depth + 1);
    return result;
  }
  return encode(error, 0);
}
