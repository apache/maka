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

import type {
  AgentRoomMessage,
  OperationReply,
} from '../../../../packages/plugin-sdk/src/index.js';

export function roomAuthorSession(message: AgentRoomMessage): string | null {
  return message.author.kind === 'session' ? message.author.execution.sessionId : null;
}

export function roomMentionAt(text: string, selection: { start: number; end: number }) {
  if (selection.start !== selection.end) return null;
  const before = text.slice(0, selection.start);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: selection.start - match[1]!.length - 1, end: selection.start, query: match[1]! };
}

export function roomResult<T>(reply: unknown): T {
  const receipt = (reply as OperationReply).receipt;
  if (receipt.kind !== 'recorded') throw new Error('Operation receipt is not recorded.');
  const outcome = receipt.outcome;
  if (outcome.kind !== 'returned') throw new Error(`Operation outcome: ${outcome.kind}`);
  if (outcome.result.kind === 'failure') throw new Error(outcome.result.diagnostic);
  return outcome.result.value as T;
}
