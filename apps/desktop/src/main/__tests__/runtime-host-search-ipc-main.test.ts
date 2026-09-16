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
import { EventEmitter } from 'node:events';
import { deferred } from '@maka/core/test-only/async-primitives';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { StoredMessage } from '@maka/core/session';
import type { SearchError, SearchResult } from '@maka/core/search';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import type { IpcHandler, ReconnectableReadIpcMain } from '../ipc-reconnect-policy.js';
import type { DesktopRuntimeHostClient } from '../runtime-host-client.js';
import { registerRuntimeHostSearchIpc } from '../runtime-host-search-ipc-main.js';
import { RuntimeHostReconnectingIpcMain } from '../runtime-host-reconnecting-ipc-main.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { createThreadSearchClient } from '../../preload/multi-host-thread-search.js';

// The catalog hands search a composed Desktop key, not a bare Runtime Host id.
// Naming it here is what makes the passthrough in runtime-host-search-ipc-main
// observable: a hit whose target carried the bare id would open nothing on a
// second Host.
const SEARCHABLE_SESSION = desktopSessionKey({
  hostId: 'host-b',
  sessionId: 'searchable-session',
});

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
      listSessions: async () => [catalogSession(SEARCHABLE_SESSION, '长对话提示词导航示例')],
      openSession: async () =>
        ({
          // Three earlier messages so the hit's `sequence` is its real position
          // in the transcript. With a single message every projection, correct
          // or not, reports 0.
          loadTranscript: async () => [
            { type: 'user', id: 'host-user-0', turnId: 'turn-host-0', ts: 1, text: '第 0 个问题' },
            { type: 'assistant', id: 'host-reply-0', turnId: 'turn-host-0', ts: 2, text: '回答 0' },
            { type: 'user', id: 'host-user-1', turnId: 'turn-host-1', ts: 3, text: '第 1 个问题' },
            {
              type: 'user',
              id: 'host-user',
              turnId: 'turn-host-3',
              ts: 4,
              text: '第 3 个问题：这一段的调用链路是怎样的？',
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
    sessionId: SEARCHABLE_SESSION,
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
    sessionId: SEARCHABLE_SESSION,
    turnId: 'turn-host-3',
    sequence: 3,
  });
  assert.equal(closed, 2);
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

test('canceling a search closes its transcript and stops reading further sessions', async () => {
  const handlers = new Map<string, IpcHandler>();
  const firstRead = deferred<void>();
  const transcript = deferred<never[]>();
  const opened: string[] = [];
  let closed = 0;
  registerRuntimeHostSearchIpc({
    ipcMain: {
      handle: (channel, listener) => { handlers.set(channel, listener); },
      handleReconnectableRead: (channel, listener) => { handlers.set(channel, listener); },
    },
    client: searchClient({
      listSessions: async () => [catalogSession('a', 'First'), catalogSession('b', 'Second')],
      openSession: async (id) => {
        opened.push(id);
        return {
          loadTranscript: () => { firstRead.resolve(); return transcript.promise; },
          close: async () => { closed += 1; transcript.resolve([]); },
        } as never;
      },
    }),
  });
  const sender = new EventEmitter();
  const event = { sender } as Parameters<IpcHandler>[0];
  const search = handlers.get('search:thread')!;
  const task = search(event, { source: 'thread', query: 'missing', limit: 10 }, 'first');
  await firstRead.promise;
  const cancel = handlers.get('search:thread:cancel');
  assert.ok(cancel, 'Desktop must expose cancellation to the preload');
  // Another window cannot cancel this window's request, even with its id.
  await cancel({ sender: new EventEmitter() } as Parameters<IpcHandler>[0], 'first');
  assert.equal(closed, 0);
  await cancel(event, 'first');
  const outcome = await task;
  assert.equal(outcome.reason, 'aborted');
  assert.deepEqual(opened, ['a']);
  assert.equal(closed, 1);
  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.equal(sender.listenerCount('render-process-gone'), 0);
});

test('a canceled search is not replayed on a replacement Host candidate', async (t) => {
  const handlers = new Map<string, IpcHandler>();
  const router = new RuntimeHostReconnectingIpcMain({
    handle: (channel, listener) => { handlers.set(channel, listener); },
    removeHandler: (channel) => { handlers.delete(channel); },
  });
  t.after(() => router.close());
  const event = { sender: new EventEmitter() } as Parameters<IpcHandler>[0];
  const scope = { hostId: 'host', targetEpoch: 'epoch' };
  const started = deferred<void>();
  const transcript = deferred<never[]>();
  let opened = 0;
  const client = searchClient({
    listSessions: async () => [catalogSession('a', 'First')],
    openSession: async () => {
      opened += 1;
      return {
        loadTranscript: () => { started.resolve(); return transcript.promise; },
        close: async () => {},
      } as never;
    },
  });
  const registerCandidate = () => {
    const target = router.createTarget('epoch');
    const scoped = (listener: IpcHandler): IpcHandler =>
      (event, _scope, ...args) => listener(event, ...args);
    const ipcMain: ReconnectableReadIpcMain = {
      handle: (channel, listener) => target.handle(channel, scoped(listener)),
      handleReconnectableRead: (channel, listener) => target.handleReconnectableRead!(channel, scoped(listener)),
    };
    registerRuntimeHostSearchIpc({ ipcMain, client });
    target.completeRegistration();
    return target;
  };
  const first = registerCandidate();
  router.activate('epoch');
  const task = handlers.get('search:thread')!(event, scope,
    { source: 'thread', query: 'missing', limit: 10 }, 'old');
  await started.promise;
  await handlers.get('search:thread:cancel')!(event, scope, 'old');
  first.removeHandler('search:thread');
  first.removeHandler('search:thread:cancel');
  registerCandidate();
  transcript.resolve([]);
  const outcome = await task;
  assert.equal(opened, 1, 'reconnecting must not revive a canceled transcript scan');
  assert.equal(outcome.reason, 'aborted');
});

for (const lifecycleEvent of ['destroyed', 'render-process-gone'] as const) {
  test(`${lifecycleEvent} stops a pending search before reading its opening transcript`, async () => {
    const handlers = new Map<string, IpcHandler>();
    const opening = deferred<never>();
    const started = deferred<void>();
    const opened: string[] = [];
    let closed = 0;
    let read = 0;
    registerRuntimeHostSearchIpc({
      ipcMain: {
        handle: (channel, listener) => { handlers.set(channel, listener); },
        handleReconnectableRead: (channel, listener) => { handlers.set(channel, listener); },
      },
      client: searchClient({
        listSessions: async () => [catalogSession('a', 'First'), catalogSession('b', 'Second')],
        openSession: async (id) => { opened.push(id); started.resolve(); return opening.promise; },
      }),
    });
    const sender = new EventEmitter();
    const task = handlers.get('search:thread')!({ sender } as Parameters<IpcHandler>[0],
      { source: 'thread', query: 'missing', limit: 10 }, 'request');
    await started.promise;
    sender.emit(lifecycleEvent, {}, { reason: 'crashed', exitCode: 1 });
    opening.resolve({
      loadTranscript: async () => { read += 1; return []; },
      close: async () => { closed += 1; },
    } as never);
    assert.equal((await task).reason, 'aborted');
    assert.deepEqual(opened, ['a']);
    assert.equal(read, 0);
    assert.equal(closed, 1);
    assert.equal(sender.listenerCount('destroyed'), 0);
    assert.equal(sender.listenerCount('render-process-gone'), 0);
  });
}

test('renderer crash closes an in-flight search and allows a new search on the same WebContents', async () => {
  const handlers = new Map<string, IpcHandler>();
  const started = deferred<void>();
  const transcript = deferred<StoredMessage[]>();
  const opened: string[] = [];
  const closed: string[] = [];
  registerRuntimeHostSearchIpc({
    ipcMain: {
      handle: (channel, listener) => { handlers.set(channel, listener); },
      handleReconnectableRead: (channel, listener) => { handlers.set(channel, listener); },
    },
    client: searchClient({
      listSessions: async () => [catalogSession('a', 'First'), catalogSession('b', 'Second')],
      openSession: async (id) => {
        opened.push(id);
        const abandoned = opened.length === 1;
        return {
          loadTranscript: async () => {
            if (abandoned) { started.resolve(); return transcript.promise; }
            return [{ type: 'user', id: 'message', turnId: 'turn', ts: 1, text: 'latest match' }];
          },
          close: async () => { closed.push(id); },
        } as never;
      },
    }),
  });
  const sender = new EventEmitter();
  const event = { sender } as Parameters<IpcHandler>[0];
  const search = handlers.get('search:thread')!;
  const abandoned = search(event, { source: 'thread', query: 'missing', limit: 10 }, 'old');
  await started.promise;
  sender.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.deepEqual(closed, ['a'], 'a crash closes the transcript before its pending reply arrives');
  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.equal(sender.listenerCount('render-process-gone'), 0);

  // Recovery reloads the same WebContents while the abandoned read is pending.
  const latest = await search(event, { source: 'thread', query: 'latest', limit: 10 }, 'new');
  assert.equal(expectResults(latest).length, 2);
  assert.deepEqual(opened, ['a', 'a', 'b']);
  assert.deepEqual(closed, ['a', 'a', 'b']);
  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.equal(sender.listenerCount('render-process-gone'), 0);

  transcript.resolve([]);
  assert.equal((await abandoned).reason, 'aborted');
  assert.deepEqual(opened, ['a', 'a', 'b'], 'a late reply must not resume the abandoned scan');
  assert.deepEqual(closed, ['a', 'a', 'b'], 'each search handle closes exactly once');
  sender.emit('destroyed');
  assert.deepEqual(closed, ['a', 'a', 'b']);
});

test('rapid replacement and dismissal stop each old scan while the latest query still completes', async () => {
  const handlers = new Map<string, IpcHandler>();
  const sender = new EventEmitter();
  const event = { sender } as Parameters<IpcHandler>[0];
  const scans: Array<{ closed: number; page: ReturnType<typeof deferred<StoredMessage[]>> }> = [];
  let started = deferred<void>();
  let completeLatest = false;
  registerRuntimeHostSearchIpc({
    ipcMain: {
      handle: (channel, listener) => { handlers.set(channel, listener); },
      handleReconnectableRead: (channel, listener) => { handlers.set(channel, listener); },
    },
    client: searchClient({
      listSessions: async () => [catalogSession('a', 'First'), catalogSession('b', 'Second')],
      openSession: async () => {
        const scan = { closed: 0, page: deferred<StoredMessage[]>() };
        scans.push(scan);
        return {
          loadTranscript: async () => {
            started.resolve();
            if (completeLatest) return [
              { type: 'user', id: 'message', turnId: 'turn', ts: 1, text: 'latest match' },
            ];
            return scan.page.promise;
          },
          close: async () => { scan.closed += 1; },
        } as never;
      },
    }),
  });
  const outcomes: Array<Promise<SearchResult[] | SearchError>> = [];
  const client = createThreadSearchClient({
    scopes: async () => ['host'],
    search: (_scope, request, requestId) => {
      const task = Promise.resolve(handlers.get('search:thread')!(event, request, requestId));
      outcomes.push(task);
      return task;
    },
    cancel: async (_scope, requestId) => {
      await handlers.get('search:thread:cancel')!(event, requestId);
    },
  });
  for (let index = 0; index < 10; index += 1) {
    started = deferred<void>();
    const task = client.thread({ source: 'thread', query: `old-${index}`, limit: 10 }, `request-${index}`);
    await started.promise;
    await client.cancelThread(`request-${index}`);
    const outcome = await task;
    assert.equal(Array.isArray(outcome), false);
    if (!Array.isArray(outcome)) assert.equal(outcome.reason, 'aborted');
    assert.equal(scans[index]!.closed, 1, 'cancellation closes a read even before its reply arrives');
    assert.equal(sender.listenerCount('destroyed'), 0, 'canceled reads release window listeners immediately');
    assert.equal(sender.listenerCount('render-process-gone'), 0, 'canceled reads release crash listeners immediately');
  }
  assert.equal(scans.length, 10, 'each old query stops at its first transcript');

  completeLatest = true;
  const latest = await client.thread({ source: 'thread', query: 'latest', limit: 10 }, 'latest');
  assert.equal(expectResults(latest).length, 2);
  assert.equal(scans.length, 12);

  // Replies for the abandoned reads can arrive after the new result. They
  // must not resume scanning further sessions or close the handles twice.
  for (const scan of scans.slice(0, 10)) scan.page.resolve([]);
  await Promise.all(outcomes);
  assert.equal(scans.length, 12);
  assert.ok(scans.every((scan) => scan.closed === 1));
  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.equal(sender.listenerCount('render-process-gone'), 0);
});

function expectResults(outcome: unknown): Array<{
  summary?: string;
  target?: {
    kind: string;
    sessionId: string;
    turnId?: string;
    sequence?: number;
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
