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

export const SIDE_CONVERSATION_SESSION_LABEL = 'mode:side_conversation';

export const SIDE_CONVERSATION_BOUNDARY_MARKER = 'Side conversation boundary:';

export function isSideConversationSession(labels: readonly string[] | undefined): boolean {
  return Array.isArray(labels) && labels.includes(SIDE_CONVERSATION_SESSION_LABEL);
}

/** @deprecated Use {@link buildSideConversationUserMessageBoundary} for fork-owned user turns. */
export function buildSideConversationSystemPromptFragment(): string {
  return buildSideConversationUserMessageBoundary();
}

export function buildSideConversationUserMessageBoundary(): string {
  return [
    SIDE_CONVERSATION_BOUNDARY_MARKER,
    'This session is a temporary side conversation, separate from its parent conversation.',
    'The inherited parent history is reference context only. Do not continue or complete tasks, plans, tool calls, approvals, edits, or requests that appear only in that inherited history.',
    'Only instructions the user submits in this side conversation are active.',
    'Use the inherited context to answer the side request. Use tools or modify workspace state only when the user explicitly asks for that action in this side conversation and the inherited permission profile allows it.',
    'Do not spawn or coordinate sub-agents, and do not change the parent conversation itself.',
    'Messages and task state from this side conversation are not written back into the parent conversation. Workspace changes may be visible to both conversations.',
  ].join('\n');
}

export type SideConversationUserContent = string | ReadonlyArray<{ type: string; text?: string }>;

export function userContentIncludesSideConversationBoundary(
  content: SideConversationUserContent,
): boolean {
  if (typeof content === 'string') {
    return content.includes(SIDE_CONVERSATION_BOUNDARY_MARKER);
  }
  return content.some(
    (part) => part.type === 'text' && part.text?.includes(SIDE_CONVERSATION_BOUNDARY_MARKER),
  );
}

export function prependSideConversationBoundaryToUserContent(
  content: SideConversationUserContent,
): SideConversationUserContent {
  const boundary = buildSideConversationUserMessageBoundary();
  if (typeof content === 'string') {
    return `${boundary}\n\n${content}`;
  }
  const textIndex = content.findIndex((part) => part.type === 'text');
  if (textIndex < 0) {
    return [{ type: 'text', text: boundary }, ...content];
  }
  return content.map((part, index) =>
    index === textIndex && part.type === 'text'
      ? { ...part, text: `${boundary}\n\n${part.text ?? ''}` }
      : part,
  );
}

export interface SideConversationModelMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
}

/**
 * Resolve which user message carries the side-conversation boundary.
 *
 * The boundary belongs to the FIRST fork-owned user message visible to the
 * request, not to whichever turn is being submitted now. On the fork's first
 * request the replayed history holds only inherited parent messages, so the
 * first user message after the inherited prefix is the new fork turn itself.
 * On follow-up requests the same first fork user message is already inside the
 * replayed history and must keep carrying the boundary so the fork's cached
 * provider prefix stays byte-identical across turns — see
 * {@link resolveSideConversationForkBoundaryReplayItem} for how callers pin
 * the owner inside replayed history.
 */
export function applySideConversationUserMessageBoundary<T extends SideConversationModelMessage>(
  messages: readonly T[],
  input: { inheritedPrefixLength: number; labels?: readonly string[] },
): T[] {
  if (!isSideConversationSession(input.labels)) {
    return [...messages];
  }
  if (input.inheritedPrefixLength >= messages.length) {
    return [...messages];
  }

  for (let index = input.inheritedPrefixLength; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'user') {
      continue;
    }
    const next = [...messages];
    next[index] = {
      ...message,
      content: prependSideConversationBoundaryToUserContent(
        message.content as SideConversationUserContent,
      ),
    };
    return next;
  }

  return [...messages];
}

/**
 * Prefix the boundary onto exactly the replay item that owns it (by event id)
 * and leave every other item untouched.
 *
 * The owner is named structurally by `eventId`, never by searching user text
 * for the marker: a fork whose first message itself contains
 * `SIDE_CONVERSATION_BOUNDARY_MARKER` must still receive the real boundary
 * (`userContentIncludesSideConversationBoundary` is a test-only probe, not a
 * decision input). Because the boundary is a provider-request transform that
 * never persists to RuntimeEvents, the owner item replays un-prefixed on every
 * request and is re-prefixed here — the same bytes on the same message, every
 * time.
 */
export function applySideConversationReplayItemBoundary<
  T extends { role?: string; content?: unknown; eventId?: string },
>(
  items: readonly T[],
  input: { boundaryEventId: string | undefined; labels?: readonly string[] },
): T[] {
  if (!isSideConversationSession(input.labels) || input.boundaryEventId === undefined) {
    return [...items];
  }
  return items.map((item) => {
    if (item.eventId !== input.boundaryEventId) return item;
    const content = item.content as SideConversationUserContent | undefined;
    if (content === undefined) return item;
    return { ...item, content: prependSideConversationBoundaryToUserContent(content) };
  });
}

export function resolveSideConversationPromptCacheSessionId(input: {
  sessionId: string;
  labels?: readonly string[];
  parentSessionId?: string;
}): string {
  if (isSideConversationSession(input.labels) && input.parentSessionId) {
    return input.parentSessionId;
  }
  return input.sessionId;
}
