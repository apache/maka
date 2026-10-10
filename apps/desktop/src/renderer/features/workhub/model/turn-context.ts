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

export interface WorkHubTurnContext {
  readonly answers: { id: string; question: string; answer: string }[];
  readonly handoffs: { id: string; targetSessionId: string; targetSessionName: string; text: string }[];
}

/** Rebuild presentation from durable answers and accepted assignments, never unaccepted tool proposals. */
export function workHubTurnContexts(messages: readonly StoredMessage[]): Map<string, WorkHubTurnContext> {
  const contexts = new Map<string, WorkHubTurnContext>();
  const calls = new Map(messages.flatMap((message) =>
    message.type === 'tool_call' ? [[message.id, message] as const] : [],
  ));
  const assignedActions = new Set(messages.flatMap((message) => message.type === 'workhub_coordination' && message.kind === 'delegation_assigned' ? [message.actionId] : []));
  const seen = new Set<string>();
  const contextFor = (turnId: string) => {
    let context = contexts.get(turnId);
    if (!context) {
      context = { answers: [], handoffs: [] };
      contexts.set(turnId, context);
    }
    return context;
  };
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    if (message.type === 'workhub_coordination' && message.kind === 'delegation_assigned') {
      contextFor(message.coordinationTurnId).handoffs.push({
        id: message.id,
        targetSessionId: message.targetSessionId,
        targetSessionName: message.targetSessionName,
        text: message.delegationText ?? message.userText,
      });
    }
    if (message.type !== 'tool_result' || message.isError) continue;
    const call = calls.get(message.toolUseId);
    if (!call || call.turnId !== message.turnId) continue;
    let result: unknown;
    if (message.content.kind === 'json') result = message.content.value;
    else if (message.content.kind === 'text') {
      try { result = JSON.parse(message.content.text); } catch { continue; }
    }
    // Live transcript pages may contain the successful tool receipt without
    // the assignment record. Pair it with the exact call that the Host accepted.
    if (result && typeof result === 'object' && 'structuredContent' in result) result = result.structuredContent;
    if (call.toolName === 'mcp__desktop_workhub__tasks') {
      const request = call.args && typeof call.args === 'object' && 'request' in call.args ? call.args.request : undefined;
      if (request && typeof request === 'object' && 'text' in request && typeof request.text === 'string' &&
        'operation' in request && ['create_new', 'delegate_existing', 'select_and_delegate'].includes(String(request.operation)) &&
        result && typeof result === 'object' && 'disposition' in result &&
        ['create_new', 'delegate_existing', 'replace'].includes(String(result.disposition)) &&
        'targetSessionKey' in result && typeof result.targetSessionKey === 'string' &&
        !('actionId' in result && typeof result.actionId === 'string' && assignedActions.has(result.actionId))) {
        contextFor(call.turnId).handoffs.push({
          id: message.id, targetSessionId: result.targetSessionKey,
          targetSessionName: 'title' in request && typeof request.title === 'string' ? request.title : '',
          text: request.text,
        });
      }
      continue;
    }
    if (call.toolName !== 'AskUserQuestion') continue;
    if (!result || typeof result !== 'object' || !('answers' in result) || !Array.isArray(result.answers)) continue;
    for (const [index, entry] of result.answers.entries()) {
      if (!entry || typeof entry !== 'object' || typeof entry.question !== 'string' ||
        typeof entry.answer !== 'string' || !entry.answer.trim()) continue;
      contextFor(call.turnId).answers.push({ id: `${message.id}:${index}`, question: entry.question, answer: entry.answer });
    }
  }
  return contexts;
}
