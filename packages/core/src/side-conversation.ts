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

export function isSideConversationSession(labels: readonly string[] | undefined): boolean {
  return Array.isArray(labels) && labels.includes(SIDE_CONVERSATION_SESSION_LABEL);
}

export function buildSideConversationSystemPromptFragment(): string {
  return [
    'Side conversation boundary:',
    'This session is a temporary side conversation, separate from its parent conversation.',
    'The inherited parent history is reference context only. Do not continue or complete tasks, plans, tool calls, approvals, edits, or requests that appear only in that inherited history.',
    'Only instructions the user submits in this side conversation are active.',
    'Use the inherited context to answer the side request. Use tools or modify workspace state only when the user explicitly asks for that action in this side conversation and the inherited permission profile allows it.',
    'Do not spawn or coordinate sub-agents, and do not change the parent conversation itself.',
    'Messages and task state from this side conversation are not written back into the parent conversation. Workspace changes may be visible to both conversations.',
  ].join('\n');
}
