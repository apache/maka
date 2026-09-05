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

declare const persistedValueBrand: unique symbol;

/**
 * An untrusted value read from durable state for the domain type `T`.
 *
 * The function-valued brand keeps `T` invariant, so related domain types
 * cannot be substituted across persistence seams. The value has no runtime
 * wrapper: a persistence adapter marks the raw value, and a decoder is the
 * only intended place that casts it back to `unknown` for inspection.
 */
export type PersistedValue<T> = {
  readonly [persistedValueBrand]: (value: T) => T;
};

/** Mark an untrusted value at the point where durable state enters the process. */
export function markPersisted<T>(value: unknown): PersistedValue<T> {
  return value as PersistedValue<T>;
}
