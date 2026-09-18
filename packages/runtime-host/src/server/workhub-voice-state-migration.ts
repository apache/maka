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

/** Upgrade persisted data only. Old shapes are never accepted by live voice tools. */
function migrateVersionOne(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1)
    return value;
  const state = value as Record<string, unknown>;
  const upgrade = (items: unknown): unknown =>
    !Array.isArray(items)
      ? items
      : items.map((item) => {
          if (!item || typeof item !== 'object' || !Object.hasOwn(item, 'continuation'))
            return item;
          const { continuation, ...rest } = item;
          if (
            !continuation ||
            typeof continuation.topic !== 'string' ||
            !continuation.topic.trim() ||
            typeof continuation.intent !== 'string' ||
            !continuation.intent.trim() ||
            rest.text !== '' ||
            rest.reply
          )
            throw new Error('Invalid persisted voice continuation');
          // Preserve the prepared intent and delivery status, never claim it was spoken.
          return { ...rest, text: `${continuation.topic}\n${continuation.intent}` };
        });
  const { deferred: _deferred, ...rest } = state;
  return {
    ...rest,
    version: 2,
    queue: upgrade(state.queue),
    deliveries: upgrade(state.deliveries),
  };
}

export function migrateVoiceState(value: unknown): unknown {
  const old = migrateVersionOne(value);
  if (!old || typeof old !== 'object' || !('version' in old) || old.version !== 2) return old;
  const { currentState: _currentState, ...state } = old as Record<string, unknown>;
  return { ...state, version: 3 };
}
