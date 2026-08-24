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
 * Delegating-actions facade behind `useStableActions` (issue #1043).
 *
 * App-shell action factories run in the render body, so every render allocates
 * fresh handler identities. Any consumer that lists a handler in an effect dep
 * array (the streaming-settle fallback timer did) tears down and re-arms on
 * every render. The facade fixes the identity without freezing the closures:
 * each method delegates to the latest committed render's factory result through
 * `latestRef`, so calls always see fresh deps while consumers see one stable
 * identity for the component's lifetime.
 *
 * Factories must return a constant key shape of function values — the
 * facade's key set is fixed at creation. Kept React-free so the behavior is
 * testable from `node:test`.
 */
export function createDelegatingActions<A extends object>(latestRef: { current: A }): A {
  const facade: Record<string, (...args: unknown[]) => unknown> = {};
  for (const key of Object.keys(latestRef.current)) {
    facade[key] = (...args: unknown[]) => {
      const action = Reflect.get(latestRef.current, key) as unknown as (...args: unknown[]) => unknown;
      return action(...args);
    };
  }
  return facade as unknown as A;
}
