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

// packages/runtime/src/preparation/placeholder-authorities.ts
// Placeholder authorities for domains that do not yet own a ResourceAuthority.
//
// - `none()`: claims=[] -> the Scheduler neither blocks this task nor is blocked
//   by it -> it starts immediately. It must be selected explicitly for tools
//   known not to occupy a modelled resource, or for synthetic/no-effect calls.
// - `all()`: claims=[{kind:'all'}] -> conflicts with everything -> global
//   serialization against non-empty claims, fail-closed. It is the conservative
//   default for real effects whose precise authority is not registered yet.

import type { AuthorityContext, PreparedOperation, ResourceAuthority } from './types.js';
import { oneShotOperation } from './one-shot-operation.js';

export const noneResourceAuthority = (): ResourceAuthority<unknown, unknown> => ({
  async prepare(_input, context: AuthorityContext): Promise<PreparedOperation<unknown>> {
    const { effect } = context;
    return oneShotOperation({
      claims: [],
      execute: (signal, fallbackEffect) =>
        fallbackEffect ? fallbackEffect() : effect ? effect(signal) : Promise.resolve(),
    });
  },
});

export const allResourceAuthority = (): ResourceAuthority<unknown, unknown> => ({
  async prepare(_input, context: AuthorityContext): Promise<PreparedOperation<unknown>> {
    const { effect } = context;
    return oneShotOperation({
      claims: [{ kind: 'all' }],
      execute: (signal, fallbackEffect) =>
        fallbackEffect ? fallbackEffect() : effect ? effect(signal) : Promise.resolve(),
    });
  },
});

/** A pre-built `none()` operation for explicit none or synthetic/no-effect calls. */
export function noneOperation(
  effect?: (signal?: AbortSignal) => Promise<unknown>,
): PreparedOperation<unknown> {
  return oneShotOperation({
    claims: [],
    execute: (signal, fallbackEffect) =>
      effect ? effect(signal) : fallbackEffect ? fallbackEffect() : Promise.resolve(),
  });
}
