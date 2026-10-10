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
import { workHubTurnContexts } from './turn-context.js';

/** Only a newly submitted local shortcut can populate the local composer. */
export function completedWorkHubDraft(messages: readonly StoredMessage[], previousIds: ReadonlySet<string>, submittedAt = 0): string | undefined {
  const request = messages.find((message) => message.type === 'user' &&
    message.ts >= submittedAt && !previousIds.has(message.id) && /^wn$/i.test(message.text.trim()));
  if (!request?.turnId) return;
  const turn = messages.filter((message) => message.turnId === request.turnId);
  const state = turn.filter((message) => message.type === 'turn_state').at(-1);
  if (state?.status !== 'completed' || !workHubTurnContexts(turn).get(request.turnId)?.answers.length) return;
  const reply = turn.filter((message) => message.type === 'assistant').at(-1);
  if (!reply || reply.interrupted) return;
  const blocks = [...reply.text.matchAll(/^```(?:text)?[ \t]*\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1) return;
  return blocks[0]?.[1]?.trim() || undefined;
}
