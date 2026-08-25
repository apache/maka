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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SESSION_LIST_TOOL_NAME,
  SESSION_REPLY_TOOL_NAME,
  SESSION_SEND_TOOL_NAME,
  buildSessionMailboxTools,
} from '../session-mailbox-tools.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';

test('Session mailbox tools bind the current Session as the source', async () => {
  const sends: unknown[] = [];
  const tools = buildSessionMailboxTools({
    list: async () => [{ sessionId: 'target-1', name: 'Target', status: 'idle' }],
    send: async (input) => {
      sends.push(input);
      return {
        messageId: 'message-1',
        targetSessionId: input.targetSessionId,
        disposition: 'queued',
      };
    },
  });

  assert.match(String(await tool(tools, SESSION_LIST_TOOL_NAME).impl({}, context())), /target-1/);
  await tool(tools, SESSION_SEND_TOOL_NAME).impl(
    { target_session_id: 'target-1', text: 'Please check', kind: 'request' },
    context(),
  );
  await tool(tools, SESSION_REPLY_TOOL_NAME).impl(
    { target_session_id: 'target-1', in_reply_to: 'request-1', text: 'Done' },
    context(),
  );

  assert.deepEqual(sends, [
    {
      sourceSessionId: 'source-1',
      targetSessionId: 'target-1',
      kind: 'request',
      text: 'Please check',
    },
    {
      sourceSessionId: 'source-1',
      targetSessionId: 'target-1',
      kind: 'reply',
      text: 'Done',
      correlationId: 'request-1',
    },
  ]);
});

function tool(tools: MakaTool[], name: string): MakaTool {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found);
  return found;
}

function context(): MakaToolContext {
  return {
    sessionId: 'source-1',
    turnId: 'turn-1',
    cwd: '/workspace',
    toolCallId: 'call-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
  };
}
