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
import { workspaceNameFromCwd } from './workspace-name.js';

import type { StoredMessage } from '@maka/core/session';

export type WorkHubDelegationState =
  | 'accepted'
  | 'running'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'recovering';

export interface WorkHubDelegationReference {
  readonly id: string;
  readonly targetSessionId: string;
  readonly targetMessageId: string;
  readonly targetTurnId: string;
}

export interface WorkHubDelegationFeedback {
  readonly id: string;
  readonly state: WorkHubDelegationState;
  readonly resultPreview?: string;
}

export interface WorkHubLinkedWork {
  readonly id: string;
  readonly coordinationTurnId: string;
  readonly targetSessionId: string;
  readonly targetSessionName: string;
  readonly workspaceName?: string;
  readonly targetMessageId?: string;
  readonly targetTurnId?: string;
  readonly state?: WorkHubDelegationState;
  readonly resultPreview?: string;
  readonly operation?: 'stop' | 'resume';
  readonly operationState?: 'pending' | 'succeeded' | 'failed';
  readonly operationOutcome?: string;
}

/** Links come from successful tool results in the same durable conversation. */
export function workHubLinkedWork(
  messages: readonly StoredMessage[],
  sessions: readonly { id: string; name: string; cwd?: string }[],
  fallbackName: string,
  coordinationSessionKey?: string,
): WorkHubLinkedWork[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const workspaceName = (id: string) => workspaceNameFromCwd(sessionById.get(id)?.cwd);
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
  const results = new Map(messages.flatMap((message) => message.type === 'tool_result' ? [[message.toolUseId, message] as const] : []));
  return messages.flatMap((message): WorkHubLinkedWork[] => {
    if (message.type === 'tool_call' && taskCalls.has(message.id)) {
      const args = message.args;
      const request = args && typeof args === 'object' && 'request' in args ? args.request : undefined;
      if (!request || typeof request !== 'object' || !('operation' in request) ||
        (request.operation !== 'stop' && request.operation !== 'resume')) return [];
      const resultMessage = results.get(message.id);
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
        operation: request.operation,
        operationState: !resultMessage ? 'pending' : resultMessage.isError || result?.disposition !== `${request.operation}_work` || result?.outcome === 'not_owned' ? 'failed' : 'succeeded',
        operationOutcome: typeof result?.outcome === 'string' ? result.outcome : undefined,
      }];
    }

    if (message.type === 'workhub_coordination' && message.kind === 'delegation_assigned') return [{
      id: message.id,
      coordinationTurnId: message.coordinationTurnId,
      targetSessionId: message.targetSessionId,
      targetSessionName: sessionById.get(message.targetSessionId)?.name ?? message.targetSessionName,
      workspaceName: workspaceName(message.targetSessionId),
      targetMessageId: message.targetMessageId,
      targetTurnId: message.targetTurnId,
      state: 'accepted',
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

export function applyWorkHubDelegationFeedback(
  assignments: readonly WorkHubLinkedWork[],
  feedback: readonly WorkHubDelegationFeedback[],
): WorkHubLinkedWork[] {
  const byId = new Map(feedback.map((item) => [item.id, item]));
  return assignments.map((assignment) => {
    const item = byId.get(assignment.id);
    return item ? { ...assignment, state: item.state, resultPreview: item.resultPreview } : assignment;
  });
}
