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

import type { ModelMessage } from './model-protocol.js';
import { runtimeContextProviderOptions } from './model-history.js';

/** Compare only host-tagged context still present in the effective model history.
 * Compaction may remove a snapshot; in that case the current value is sent again.
 */
export function changedRuntimeContexts(
  contexts: readonly { readonly name: string; readonly text: string }[],
  messages: readonly ModelMessage[],
): { name: string; text: string }[] {
  const latest = new Map<string, string>();
  for (const message of messages) {
    const name = message.providerOptions?.makaRuntimeContext?.name;
    if (message.role !== 'user' || typeof name !== 'string') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('');
    latest.set(name, text);
  }
  const changes: { name: string; text: string }[] = [];
  for (const context of contexts) {
    const text = `Runtime context (${context.name}; host metadata, not a user request; later updates supersede earlier values):\n${context.text}`;
    if (latest.get(context.name) === text) continue;
    changes.push({ name: context.name, text });
    latest.set(context.name, text);
  }
  return changes;
}

export function runtimeContextMessage(context: { name: string; text: string }): ModelMessage {
  return {
    role: 'user',
    content: context.text,
    providerOptions: runtimeContextProviderOptions(context.name),
  };
}
