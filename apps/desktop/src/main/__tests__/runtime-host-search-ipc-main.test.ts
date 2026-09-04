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
import { test } from 'node:test';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import type { DesktopRuntimeHostClient } from '../runtime-host-client.js';
import { registerRuntimeHostSearchIpc } from '../runtime-host-search-ipc-main.js';

test('Runtime Host transcripts produce title and content hits with turn ids', async () => {
  const handlers = new Map<string, IpcHandler>();
  let closed = 0;
  registerRuntimeHostSearchIpc({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      handleReconnectableRead: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    client: searchClient({
      listSessions: async () => [catalogSession('searchable-session', '长对话提示词导航示例')],
      openSession: async () =>
        ({
          loadTranscript: async () => [
            {
              type: 'user',
              id: 'host-user',
              turnId: 'turn-host-3',
              ts: 1,
              text: '第 3 个问题：这一段的调用链路是怎样的？',
            },
            {
              type: 'tool_call',
              id: 'browser-call',
              turnId: 'turn-host-3',
              ts: 2,
              toolName: 'mcp__desktop_browser__browser_navigate',
              displayName: 'browser_navigate',
              intent: '打开检查页面',
              args: {},
            },
            {
              type: 'tool_result',
              id: 'browser-result',
              turnId: 'turn-host-3',
              ts: 3,
              toolUseId: 'browser-call',
              isError: true,
              content: { kind: 'text', text: '检查页面失败' },
            },
          ],
          close: async () => {
            closed += 1;
          },
        }) as never,
    }),
  });

  const handler = handlers.get('search:thread');
  assert.ok(handler);
  const titleHits = expectResults(
    await handler({} as never, {
      source: 'thread',
      query: '长对话',
      limit: 10,
    }),
  );
  assert.equal(titleHits[0]?.summary, '任务标题');
  assert.deepEqual(titleHits[0]?.target, {
    kind: 'thread',
    sessionId: 'searchable-session',
    matchKind: 'session_title',
  });

  const contentHits = expectResults(
    await handler({} as never, {
      source: 'thread',
      query: '第 3 个问题',
      limit: 10,
    }),
  );
  assert.equal(contentHits.length, 1);
  assert.equal(contentHits[0]?.summary, '用户消息');
  assert.deepEqual(contentHits[0]?.target, {
    kind: 'thread',
    sessionId: 'searchable-session',
    turnId: 'turn-host-3',
    sequence: 0,
    matchKind: 'user_message',
  });

  const toolHit = expectResults(
    await handler({} as never, { source: 'thread', query: '打开检查', limit: 10 }),
  )[0];
  assert.deepEqual(toolHit?.target?.tool, {
    name: 'mcp__desktop_browser__browser_navigate',
    displayName: 'browser_navigate',
  });
  const resultHit = expectResults(
    await handler({} as never, { source: 'thread', query: '检查页面失败', limit: 10 }),
  )[0];
  assert.equal(resultHit?.target?.toolResultIsError, true);
  assert.equal(closed, 4);
});

test('a Runtime Host transcript failure yields no content hit', async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostSearchIpc({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      handleReconnectableRead: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    client: searchClient({
      listSessions: async () => [catalogSession('searchable-session', '长对话提示词导航示例')],
      openSession: async () => {
        throw new Error('Host transcript unavailable');
      },
    }),
  });

  const handler = handlers.get('search:thread');
  assert.ok(handler);
  assert.deepEqual(
    await handler({} as never, {
      source: 'thread',
      query: '第 3 个问题',
      limit: 10,
    }),
    [],
  );
});

function expectResults(outcome: unknown): Array<{
  summary?: string;
  target?: {
    kind: string;
    sessionId: string;
    turnId?: string;
    sequence?: number;
    matchKind?: string;
    tool?: { name: string; displayName?: string };
    toolResultIsError?: boolean;
  };
}> {
  if (!Array.isArray(outcome)) {
    assert.fail(`expected search results, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function searchClient(
  overrides: Partial<Pick<DesktopRuntimeHostClient, 'listSessions' | 'openSession'>>,
): Pick<DesktopRuntimeHostClient, 'listSessions' | 'openSession' | 'queryRuntimePolicy'> {
  return {
    listSessions: async () => [],
    openSession: async () => {
      throw new Error('openSession is not used by this test');
    },
    queryRuntimePolicy: async () => ({
      revision: 1,
      policy: createDefaultRuntimePolicy(),
    }),
    ...overrides,
  };
}

function catalogSession(id: string, name: string): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: '/workspace' },
      hostCwd: '/workspace',
    },
    createdAt: 1,
    activityAt: 1,
    lastMessageAt: 1,
    name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'zai-live',
    connectionLocked: true,
    model: 'glm-5.1',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}
