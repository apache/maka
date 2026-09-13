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

import type { JSONValue, ToolResultOutput } from './model-protocol.js';

/**
 * Coerce an arbitrary tool result into a JSON-safe value (non-JSON scalars are
 * stringified). Used to satisfy the `{type:'json'|'error-json', value}` arms.
 */
export function jsonValue(value: unknown): JSONValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    Array.isArray(value) ||
    typeof value === 'object'
  ) {
    return value as JSONValue;
  }
  return String(value);
}

/**
 * Wrap a raw tool result as canonical provider-facing tool output, choosing the
 * text vs json arm by value type and the error vs success arm by `isError`.
 */
export function toolResultOutput(value: unknown, isError: boolean): ToolResultOutput {
  if (isError) {
    return typeof value === 'string'
      ? { type: 'error-text', value }
      : { type: 'error-json', value: jsonValue(value) };
  }
  return typeof value === 'string'
    ? { type: 'text', value }
    : { type: 'json', value: jsonValue(value) };
}
