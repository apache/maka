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

type Scopes = {
  actionDefinitions: string | null;
};
type Topic = keyof Scopes;
type Listener<K extends Topic> = (scope: Scopes[K]) => void;
type Subscribers = { [K in Topic]: Set<Listener<K>> };

// Independently compiled UI bundles share one window VM.
const OWNER = Symbol.for('maka.ui-sync');
const shared: typeof globalThis & { [OWNER]?: Subscribers } = globalThis;
const subscribers = (shared[OWNER] ??= {
  actionDefinitions: new Set(),
});

export function subscribe<K extends Topic>(topic: K, listener: Listener<K>) {
  const channel: Set<Listener<K>> = subscribers[topic];
  channel.add(listener);
  return () => channel.delete(listener);
}

export function invalidate<K extends Topic>(
  topic: K,
  scope: Scopes[K],
  exceptListener?: Listener<K>,
): void {
  const channel: Set<Listener<K>> = subscribers[topic];
  for (const listener of channel) if (listener !== exceptListener) listener(scope);
}
