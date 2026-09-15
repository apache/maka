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
 * Provider retirement — the one owner of "did Maka stop offering this
 * provider?".
 *
 * Kept out of `provider-registry.ts` on purpose. Retirement is a handful of
 * provider-type strings, but the registry is built from the generated
 * models.dev tables, so anything that imported the predicate from there pulled
 * the whole metadata snapshot in with it. The Desktop first screen needs this
 * boolean and nothing else from the catalog; see
 * `docs/model-metadata-firstscreen-optimization.md`.
 *
 * The type-only import below is erased at build time, so this module has no
 * runtime dependency on the registry.
 */

import type { ProviderType } from './provider-registry.js';

/**
 * Provider types Maka used to offer and no longer does. The registry keeps its
 * entry so stored connections still decode; retirement only says it cannot be
 * used to send.
 *
 * `packages/core/src/__tests__/provider-catalog-contract.test.ts` pins this
 * list against the registry, so a name that is not a registered provider — or a
 * retired provider that is still wired to a Runtime adapter — fails there.
 */
export const RETIRED_PROVIDER_TYPES: readonly ProviderType[] = ['claude-subscription'];

const RETIRED_PROVIDER_TYPE_SET: ReadonlySet<string> = new Set<string>(RETIRED_PROVIDER_TYPES);

/**
 * A provider Maka used to offer and no longer does. Read this rather than
 * inferring retirement from an unavailable adapter: a provider that was never
 * wired looks identical from there and is not the same thing.
 *
 * Takes a plain `string` because stored connections outlive the catalog: a
 * connection written by a newer build can name a provider type this one does
 * not know, and an unknown type is not retired.
 */
export function isRetiredProvider(providerType: string): boolean {
  return RETIRED_PROVIDER_TYPE_SET.has(providerType);
}
