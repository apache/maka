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


import { desktopSessionKey, parseDesktopSessionKey } from '../../../../shared/runtime-host-identity.js';
import { readWorkHubTopicAssociation, workHubAssociationTarget } from '../../../../shared/desktop-session-projection.js';
import { workspaceNameFromCwd } from './workspace-name.js';

import type { StoredMessage, ToolResultMessage } from '@maka/core/session';

export interface WorkHubLinkedWork {
  readonly id: string;
  readonly coordinationTurnId: string;
  readonly targetSessionId: string;
  readonly targetSessionName: string;
  readonly workspaceName?: string;
}

/** Links come from durable task receipts and Host-owned result origins. */
export function workHubLinkedWork(
  messages: readonly StoredMessage[],
  sessions: readonly { id: string; name: string; cwd?: string }[],
  fallbackName: string,
  coordinationSessionKey?: string,
): WorkHubLinkedWork[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const workspaceName = (id: string) => workspaceNameFromCwd(sessionById.get(id)?.cwd);
  // Providers may reuse a tool-call id in a later turn, so call-side lookups
  // are keyed by turn first and can only pair a result with its own turn.
  const associationCalls = new Map<string, Map<string, string | null>>();
  for (const message of messages) {
    if (message.type !== 'tool_call') continue;
    const target = workHubAssociationTarget(message);
    if (target === undefined) continue;
    let byId = associationCalls.get(message.turnId);
    if (!byId) associationCalls.set(message.turnId, byId = new Map());
    byId.set(message.id, target);
  }
  const taskCalls = new Set(messages.flatMap((message) =>
    message.type === 'tool_call' && message.toolName === 'mcp__desktop_workhub__tasks' ? [message.id] : [],
  ));
  const readResult = (message: StoredMessage | undefined): Record<string, unknown> | undefined => {
    if (message?.type !== 'tool_result') return undefined;
    let value: unknown;
    if (message.content.kind === 'json') value = message.content.value;
    else if (message.content.kind === 'text') {
      try { value = JSON.parse(message.content.text); } catch { return undefined; }
    }
    if (value && typeof value === 'object' && 'structuredContent' in value) value = value.structuredContent;
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  };
  const results = new Map<string, Map<string, ToolResultMessage>>();
  for (const message of messages) {
    if (message.type !== 'tool_result') continue;
    let byId = results.get(message.turnId);
    if (!byId) results.set(message.turnId, byId = new Map());
    byId.set(message.toolUseId, message);
  }
  // Association is mutable per turn. Fold only validated decisions in transcript
  // order; clearing a topic must not retract actual execution/result links.
  const topics = new Map<string, WorkHubLinkedWork>();
  for (const message of messages) {
    if (message.type !== 'tool_result') continue;
    const expected = associationCalls.get(message.turnId)?.get(message.toolUseId);
    const topic = expected === undefined ? undefined : readWorkHubTopicAssociation(message, expected);
    if (!topic) continue;
    if (topic.targetSessionId === null) topics.delete(message.turnId);
    else topics.set(message.turnId, {
      id: message.id, coordinationTurnId: message.turnId,
      targetSessionId: topic.targetSessionKey,
      targetSessionName: sessionById.get(topic.targetSessionKey)?.name ?? topic.targetSessionName,
      workspaceName: workspaceName(topic.targetSessionKey),
    });
  }
  return messages.flatMap((message): WorkHubLinkedWork[] => {
    const topic = message.type === 'tool_result' ? topics.get(message.turnId) : undefined;
    if (topic?.id === message.id) return [topic];
    // A result notification starts its own coordination turn. It remains
    // linked even when that turn only summarizes the result without tools,
    // or the original delegation is outside the loaded history window.
    if (message.type === 'user' && message.origin?.kind === 'workhub_result') {
      if (!coordinationSessionKey) return [];
      let target: string;
      try {
        target = desktopSessionKey({
          hostId: parseDesktopSessionKey(coordinationSessionKey).hostId,
          sessionId: message.origin.targetSessionId,
        });
      } catch { return []; }
      return [{
        id: message.id, coordinationTurnId: message.turnId, targetSessionId: target,
        targetSessionName: sessionById.get(target)?.name ?? fallbackName,
        workspaceName: workspaceName(target),
      }];
    }
    if (message.type === 'tool_call' && taskCalls.has(message.id)) {
      const args = message.args;
      const request = args && typeof args === 'object' && 'request' in args ? args.request : undefined;
      if (!request || typeof request !== 'object' || !('operation' in request) ||
        (request.operation !== 'stop' && request.operation !== 'resume')) return [];
      const resultMessage = results.get(message.turnId)?.get(message.id);
      const result = readResult(resultMessage);
      let target = typeof result?.targetSessionKey === 'string' && !resultMessage?.isError ? result.targetSessionKey : undefined;
      if (!target && coordinationSessionKey && 'targetSessionId' in request && typeof request.targetSessionId === 'string') {
        try {
          const key = desktopSessionKey({ hostId: parseDesktopSessionKey(coordinationSessionKey).hostId, sessionId: request.targetSessionId });
          if (sessionById.has(key)) target = key;
        } catch { /* An unscoped identity cannot identify a Host-owned Session. */ }
      }
      if (!target) return [];
      return [{ id: message.id, coordinationTurnId: message.turnId, targetSessionId: target,
        targetSessionName: sessionById.get(target)?.name ?? fallbackName, workspaceName: workspaceName(target),
      }];
    }

    if (message.type === 'workhub_coordination' && message.kind === 'delegation_assigned') return [{
      id: message.id,
      coordinationTurnId: message.coordinationTurnId,
      targetSessionId: message.targetSessionId,
      targetSessionName: sessionById.get(message.targetSessionId)?.name ?? message.targetSessionName,
      workspaceName: workspaceName(message.targetSessionId),
    }];
    if (message.type !== 'tool_result' || message.isError || !taskCalls.has(message.toolUseId)) return [];
    let result: unknown;
    if (message.content.kind === 'json') result = message.content.value;
    else if (message.content.kind === 'text') {
      try { result = JSON.parse(message.content.text); } catch { return []; }
    }
    if (result && typeof result === 'object' && 'structuredContent' in result) result = result.structuredContent;
    if (!result || typeof result !== 'object' || !('disposition' in result) ||
      !['create_new', 'delegate_existing', 'replace'].includes(String(result.disposition)) ||
      !('targetSessionKey' in result) || typeof result.targetSessionKey !== 'string') return [];
    return [{
      id: message.id,
      coordinationTurnId: message.turnId,
      targetSessionId: result.targetSessionKey,
      targetSessionName: sessionById.get(result.targetSessionKey)?.name ?? fallbackName,
      workspaceName: workspaceName(result.targetSessionKey),
    }];
  });
}
