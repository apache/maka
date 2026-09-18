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

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { MessageContent } from '@maka/core/events';
import { WORKHUB_COORDINATION_SESSION_ID, type StoredMessage } from '@maka/core/session';

/** The Host annotates complete invocations before either live or historical paging. */
export function annotateVoicePresentation(
  sessionId: string,
  messages: readonly StoredMessage[],
  events: readonly RuntimeEvent[],
  sourceEventIds: readonly string[],
  admittedSources: ReadonlyMap<string, NonNullable<MessageContent['workhubSource']>> = new Map(),
): StoredMessage[] {
  if (sessionId !== WORKHUB_COORDINATION_SESSION_ID) return [...messages];
  const internalTurns = new Set<string>();
  const internalEvents = new Set<string>();
  const sourceByEvent = new Map<string, NonNullable<MessageContent['workhubSource']>>();
  for (const event of events) {
    if (event.role === 'user' && event.content?.kind === 'text') {
      // Old first events may lack the source still preserved by their admission.
      // A steering input owns its own source; never borrow the root's identity.
      const source =
        event.content.workhubSource ??
        (!event.content.steering ? admittedSources.get(event.turnId) : undefined);
      if (source) {
        if (source !== 'text_request' && source !== 'task_result') internalTurns.add(event.turnId);
        sourceByEvent.set(event.id, source);
      }
    }
    if (internalTurns.has(event.turnId)) internalEvents.add(event.id);
  }
  const internalTools = new Set(
    messages
      .filter((message) => message.type === 'tool_call' && message.presentation === 'internal')
      .map((message) => message.id),
  );
  return messages.map((message, index) => {
    if (message.presentation === 'public') return message;
    const eventId = sourceEventIds[index]!;
    const source =
      sourceByEvent.get(eventId) ?? (message.type === 'user' ? message.workhubSource : undefined);
    let internal = message.presentation === 'internal' || internalEvents.has(eventId);
    if (message.type === 'user')
      internal =
        message.presentation === 'internal' ||
        source === 'voice_maintenance' ||
        source === 'task_result';
    if (message.type === 'tool_call' && internal) internalTools.add(message.id);
    if (
      (message.type === 'tool_result' || message.type === 'permission_decision') &&
      internalTools.has(message.toolUseId)
    )
      internal = true;
    const sourced =
      message.type === 'user' && source && !message.workhubSource
        ? { ...message, workhubSource: source }
        : message;
    return internal ? { ...sourced, presentation: 'internal' as const } : sourced;
  });
}
