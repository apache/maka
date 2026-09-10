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


import type { StoredMessage } from '@maka/core/session';

export interface WorkHubLinkedWork {
  readonly id: string;
  readonly coordinationTurnId: string;
  readonly targetSessionId: string;
  readonly targetSessionName: string;
}

/** Links come from successful tool results in the same durable conversation. */
export function workHubLinkedWork(
  messages: readonly StoredMessage[],
  sessions: readonly { id: string; name: string }[],
  fallbackName: string,
): WorkHubLinkedWork[] {
  const names = new Map(sessions.map((session) => [session.id, session.name]));
  const taskCalls = new Set(messages.flatMap((message) =>
    message.type === 'tool_call' && message.toolName === 'mcp__desktop_workhub__tasks' ? [message.id] : [],
  ));
  return messages.flatMap((message): WorkHubLinkedWork[] => {
    if (message.type === 'workhub_coordination' && message.kind === 'delegation_assigned') return [message];
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
      targetSessionName: names.get(result.targetSessionKey) ?? fallbackName,
    }];
  });
}
