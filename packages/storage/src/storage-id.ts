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

const SAFE_STORAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Returns whether a value can safely be used as a persisted storage identity. */
export function isSafeStorageId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_STORAGE_ID_PATTERN.test(value);
}

/** Throws a TypeError unless the value is a safe persisted storage identity. */
export function assertSafeStorageId(
  value: unknown,
  message = 'Storage identity is invalid',
): asserts value is string {
  if (!isSafeStorageId(value)) throw new TypeError(message);
}
