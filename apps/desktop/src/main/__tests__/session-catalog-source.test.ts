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
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { LocaleProvider } from '@maka/ui';
import type { SessionChangedEvent } from '@maka/core/session';
import {
  createSessionCatalogController,
  type SessionCatalogSource,
} from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import { createDesktopSessionCatalogSource } from '../../renderer/platform/desktop/session-catalog-sync.js';
import { useAppShellSessionList } from '../../renderer/use-app-shell-session-list.js';
import type { DesktopSessionSummary } from '../../shared/desktop-session-projection.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

const summary = (id: string, name = id): DesktopSessionSummary => ({
  id, name, isFlagged: false, isArchived: false, labels: [],
  hasUnread: false, status: 'active', backend: 'ai-sdk',
  revision: 1, activityAt: 1, runtimeHostId: 'local', profileId: 'local', profileName: 'Local',
  llmConnectionSlug: 'test', connectionLocked: false, model: 'test',
  permissionMode: 'ask', profileKind: 'local',
}) as DesktopSessionSummary;

test('the shell refreshes the catalog through the catalog source, not the bridge', async () => {
  const reads: string[] = [];
  const source: SessionCatalogSource = {
    list: async () => { reads.push('list'); return [summary('a'), summary('b')]; },
    subscribeChanges: () => () => {},
  };
  const catalog = createSessionCatalogController(source);
  let list!: ReturnType<typeof useAppShellSessionList>;
  function Probe() {
    list = useAppShellSessionList({ error: (title) => assert.fail(title) }, { catalog });
    return null;
  }
  const { root } = installReactRenderer();
  await act(async () => root.render(createElement(LocaleProvider, { locale: 'en', children: createElement(Probe) })));
  await act(async () => { await list.refreshSessions(); });
  assert.deepEqual(reads, ['list']);
  assert.deepEqual(catalog.getState().sessions.map((session) => session.id), ['a', 'b']);
  await act(async () => root.unmount());
});

test('Desktop backs the catalog source with the Session bridge', async () => {
  const calls: string[] = [];
  const handler = (_event: SessionChangedEvent) => {};
  const source = createDesktopSessionCatalogSource({
    sessions: {
      list: async () => { calls.push('list'); return []; },
      subscribeChanges: (subscribed: typeof handler) => { calls.push(subscribed === handler ? 'subscribe' : 'subscribe:other'); return () => {}; },
    },
  } as unknown as Parameters<typeof createDesktopSessionCatalogSource>[0]);
  await source.list();
  source.subscribeChanges(handler);
  assert.deepEqual(calls, ['list', 'subscribe']);
});

test('a catalog built without a source cannot be read through it', async () => {
  const catalog = createSessionCatalogController();
  await assert.rejects(catalog.source.list(), /created without a source/);
  assert.throws(() => catalog.source.subscribeChanges(() => {}), /created without a source/);
});
