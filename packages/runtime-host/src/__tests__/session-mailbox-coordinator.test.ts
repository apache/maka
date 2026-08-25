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
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { HostMessageCoordinator } from '../server/message-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostSessionMailboxCoordinator } from '../server/session-mailbox-coordinator.js';

test('Session mailbox exposes only ordinary Sessions in the source workspace', async () => {
  const coordinator = mailbox([
    session('source', '/one', { projectId: 'project-1' }),
    session('target', '/one', { projectId: 'project-1', runningTurnIds: ['turn-live'] }),
    session('other-project', '/one', { projectId: 'project-2' }),
    session('side', '/one', { projectId: 'project-1', labels: ['mode:side_conversation'] }),
    session('child', '/one', {
      projectId: 'project-1',
      subagentParent: {
        kind: 'subagent',
        parentSessionId: 'source',
        spawnedBy: { parentRunId: 'run-1', parentTurnId: 'turn-1', toolCallId: 'call-1' },
        lifecycle: 'foreground',
      },
    }),
  ]);

  const outcome = await coordinator.handlers['session.mailbox.targets'](
    { sourceSessionId: 'source' },
    connection(),
  );

  assert.deepEqual(outcome, {
    ok: true,
    result: {
      targets: [{ sessionId: 'target', name: 'target', status: 'running' }],
    },
  });
});

test('Session mailbox submits a next-turn message with Host provenance', async () => {
  let submitted: unknown;
  const stored: StoredMessage[] = [{
    type: 'system_note',
    id: 'start',
    turnId: 'source-turn',
    ts: 1,
    kind: 'session_start',
  }];
  const coordinator = mailbox(
    [session('source', '/one'), session('target', '/one')],
    async (input) => {
      submitted = input;
      return { ok: true, result: { disposition: 'turn_started', turnId: 'turn-2' } };
    },
    stored,
  );

  const outcome = await coordinator.handlers['session.mailbox.send'](
    {
      sourceSessionId: 'source',
      targetSessionId: 'target',
      messageId: 'message-1',
      kind: 'request',
      text: 'Please inspect this',
    },
    connection(),
  );

  assert.deepEqual(outcome, {
    ok: true,
    result: {
      messageId: 'message-1',
      targetSessionId: 'target',
      disposition: 'turn_started',
      turnId: 'turn-2',
    },
  });
  assert.deepEqual(submitted, {
    originHostEpoch: 'epoch-1',
    sessionId: 'target',
    messageId: 'message-1',
    content: {
      text: [
        '<session_message message_id="message-1" from_session_id="source" from_session_name="source" to_session_id="target" kind="request">',
        'From session "source":',
        'Please inspect this',
        '',
        'Reply with session_reply(target_session_id="source", in_reply_to="message-1", text=...).',
        '</session_message>',
      ].join('\n'),
      displayText: 'From source: Please inspect this',
      inlineReferences: [],
    },
    placement: 'next_turn',
  });
  assert.deepEqual(stored.at(-1), {
    type: 'system_note',
    id: 'session-mailbox-sent:message-1',
    turnId: 'source-turn',
    ts: 123,
    kind: 'session_mailbox_sent',
    data: {
      messageId: 'message-1',
      targetSessionId: 'target',
      targetSessionName: 'target',
      kind: 'request',
      text: 'Please inspect this',
      disposition: 'turn_started',
    },
  });
});

test('Session mailbox rejects self-send and cross-workspace targets', async () => {
  const coordinator = mailbox([session('source', '/one'), session('target', '/two')]);
  const self = await coordinator.handlers['session.mailbox.send'](
    {
      sourceSessionId: 'source',
      targetSessionId: 'source',
      messageId: 'message-1',
      kind: 'notification',
      text: 'No',
    },
    connection(),
  );
  const crossWorkspace = await coordinator.handlers['session.mailbox.send'](
    {
      sourceSessionId: 'source',
      targetSessionId: 'target',
      messageId: 'message-2',
      kind: 'notification',
      text: 'No',
    },
    connection(),
  );

  assert.equal(self.ok, false);
  if (!self.ok) assert.equal(self.error.code, 'invalid_request');
  assert.equal(crossWorkspace.ok, false);
  if (!crossWorkspace.ok) assert.equal(crossWorkspace.error.code, 'not_found');
});

function mailbox(
  sessions: SessionSummary[],
  submit: (input: unknown) => Promise<unknown> = async () => ({
    ok: true,
    result: { disposition: 'followup', queueRevision: 1 },
  }),
  stored: StoredMessage[] = [],
): HostSessionMailboxCoordinator {
  const messages = {
    handlers: { 'turn.message.submit': submit },
  } as unknown as Pick<HostMessageCoordinator, 'handlers'>;
  return new HostSessionMailboxCoordinator({
    hostEpoch: 'epoch-1',
    messages,
    listSessions: async () => sessions,
    sessionStore: {
      readMessagesSnapshot: async () => stored,
      appendMessage: async (_sessionId, message) => {
        stored.push(message);
      },
    },
    createId: () => 'message-generated',
    now: () => 123,
  });
}

function session(id: string, cwd: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    cwd,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection',
    connectionLocked: true,
    model: 'model',
    permissionMode: 'ask',
    ...overrides,
  };
}

function connection(): ConnectionContext {
  return {
    hostEpoch: 'epoch-1',
    connectionId: 'connection-1',
    principal: 'owner',
    acquireResidency: () => ({ release: () => undefined }),
  };
}
