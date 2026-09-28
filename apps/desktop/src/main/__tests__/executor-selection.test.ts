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
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ExecutorCatalogEntry } from '@maka/core/executor-catalog';
import type { SessionSummary } from '@maka/core/session';
import { useExecutorSelection, newTaskConfiguration, ConversationServicesProvider, type ConversationServices } from '../../renderer/features/conversation/index.js';

const entry: ExecutorCatalogEntry = { id: 'external', displayName: 'External', readiness: 'ready', models: [{ id: 'selected', name: 'Selected' }], supportsAttachments: false, supportsModelChange: true };

test('a catalog change during failed discovery retries after the in-flight result settles', async () => {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const values = { document, window, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  let latest!: ReturnType<typeof useExecutorSelection>;
  let notify!: () => void;
  let finishFirst!: (value: readonly ExecutorCatalogEntry[]) => void;
  const first = new Promise<readonly ExecutorCatalogEntry[]>(resolve => { finishFirst = resolve; });
  let reads = 0;
  const services = {
    subscribeChanges: () => () => {},
    newTasks: {
      subscribeChanges: (handler: () => void) => { notify = handler; return () => {}; },
      getExecutors: async () => (++reads === 1 ? first : [entry]),
    },
    sessions: {},
  } as unknown as ConversationServices;
  function Probe() {
    latest = useExecutorSelection({ key: 'new-task', cwd: '/fixture', target: { hostId: 'host', profileId: 'profile', projectId: null } });
    return null;
  }
  try {
    await act(async () => root.render(createElement(ConversationServicesProvider, { services, children: createElement(Probe) })));
    assert.equal(reads, 1);
    notify();
    await act(async () => {
      finishFirst([{ ...entry, readiness: 'unavailable', models: [] }]);
      await first;
    });
    assert.equal(reads, 2);
    assert.equal(latest.entry, undefined);
    assert.deepEqual(latest.catalog, [entry]);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test('late draft discovery cannot replace the current target; existing tasks inspect without probing', async () => {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const values = { document, window, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  let latest!: ReturnType<typeof useExecutorSelection>;
  let discoveryCalls = 0, inspectionCalls = 0;
  let finishOld!: (value: readonly ExecutorCatalogEntry[]) => void;
  const old = new Promise<readonly ExecutorCatalogEntry[]>(resolve => { finishOld = resolve; });
  let ready = false;
  let serverModel = 'selected';
  let inspect = async (): Promise<readonly ExecutorCatalogEntry[]> => [{
    ...entry,
    currentModel: serverModel,
    readiness: ready ? 'ready' : 'history_only',
  }];
  let write: () => Promise<unknown> = async () => ({ ok: false, code: 'operation_unavailable' });
  const services = {
    subscribeChanges: () => () => {},
    newTasks: { subscribeChanges: () => () => {}, getExecutors: async () => { discoveryCalls++; return discoveryCalls === 1 ? old : [entry]; } },
    sessions: { getExecutorState: async () => { inspectionCalls++; return inspect(); }, setExecutorModelConfiguration: () => write() },
  } as unknown as ConversationServices;
  function Probe(props: { draftKey: string; session?: SessionSummary }) {
    latest = useExecutorSelection({ key: props.draftKey, cwd: '/fixture', target: { hostId: 'host', profileId: 'profile', projectId: null }, session: props.session });
    return null;
  }
  async function render(draftKey: string, session?: SessionSummary) {
    await act(async () => root.render(createElement(ConversationServicesProvider, { services, children: createElement(Probe, { draftKey, session }) })));
  }
  try {
    await render('old');
    await render('current');
    assert.deepEqual(latest.catalog, [entry]);
    await act(async () => { finishOld([{ ...entry, id: 'stale' }]); await old; });
    assert.deepEqual(latest.catalog, [entry]);
    await act(async () => latest.select({ executorId: 'external', configuration: { model: 'selected' } }));
    await act(async () => latest.refresh());
    assert.equal(latest.selection?.configuration.model, 'selected');
    await render('current', { id: 'saved', executorId: 'external', executorConfig: { model: 'selected' } } as SessionSummary);
    assert.equal(latest.entry?.readiness, 'history_only');
    assert.equal(discoveryCalls, 3);
    assert.equal(inspectionCalls, 1);
    let finishInspection!: (value: readonly ExecutorCatalogEntry[]) => void;
    const slowInspection = new Promise<readonly ExecutorCatalogEntry[]>((resolve) => {
      finishInspection = resolve;
    });
    inspect = () => slowInspection;
    let firstRefresh!: Promise<void>;
    let duplicateRefresh!: Promise<void>;
    await act(async () => {
      firstRefresh = latest.refresh();
      duplicateRefresh = latest.refresh();
      await Promise.resolve();
    });
    assert.equal(firstRefresh, duplicateRefresh, 'concurrent inspections share one request');
    assert.equal(inspectionCalls, 2);
    await act(async () => {
      finishInspection([{ ...entry, currentModel: serverModel, readiness: 'history_only' }]);
      await firstRefresh;
    });
    inspect = async () => [{
      ...entry,
      currentModel: serverModel,
      readiness: ready ? 'ready' : 'history_only',
    }];
    await act(async () => { await assert.rejects(latest.select({ executorId: 'external', configuration: { model: 'rejected' } })); });
    assert.equal(latest.selection?.configuration.model, 'selected');
    assert.equal(latest.error, 'operation_unavailable');
    ready = true;
    await act(async () => latest.refresh());
    let confirm!: (value: unknown) => void;
    write = () => new Promise(resolve => { confirm = resolve; });
    let pending!: Promise<void>;
    await act(async () => { pending = latest.select({ executorId: 'external', configuration: { model: 'fast' } }); });
    assert.equal(latest.selection?.configuration.model, 'selected', 'pending write is not displayed');
    assert.equal(latest.changing, true);
    await act(async () => {
      await assert.rejects(latest.select({ executorId: 'external', configuration: { model: 'other' } }), /pending/);
      serverModel = 'fast';
      confirm({ ok: true, session: { executorConfig: { model: 'fast' } } });
      await pending;
    });
    assert.equal(latest.selection?.configuration.model, 'fast', 'confirmed state replaces stale Session props');
    assert.equal(latest.changing, false);
    serverModel = 'selected';
    await act(async () => latest.refresh());
    assert.equal(latest.selection?.configuration.model, 'selected', 'Agent state updates synchronize the control');
    await act(async () => { pending = latest.select({ executorId: 'external', configuration: { model: 'fast' } }); });
    await render('next-draft');
    await act(async () => {
      confirm({ ok: true, session: { executorConfig: { model: 'fast' } } });
      await pending;
    });
    assert.equal(latest.selection, undefined);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});


test('native task creation preserves untouched, provider-default and explicit thinking choices', () => {
  for (const level of [undefined, null, 'high'] as const) {
    const configuration = newTaskConfiguration({
      newChatModel: null, pendingNewChatThinkingLevel: level,
      newChatPermissionChoice: undefined, newChatCollaborationMode: 'agent',
      newChatOrchestrationMode: 'default',
    });
    assert.equal(configuration.thinkingLevel, level);
    assert.equal(Object.hasOwn(configuration, 'executorId'), false);
  }
});

test('an executor choice uses its exact model without inheriting native thinking or orchestration', () => {
  const configuration = newTaskConfiguration({
    executorSelection: { executorId: 'external', configuration: { model: 'selected' } },
    newChatModel: { llmConnectionId: 'native', llmConnectionSlug: 'native', model: 'native-model' },
    pendingNewChatThinkingLevel: 'high', newChatPermissionChoice: undefined,
    newChatCollaborationMode: 'plan', newChatOrchestrationMode: 'swarm',
  });
  assert.ok('executorId' in configuration);
  assert.equal(configuration.executorId, 'external');
  assert.deepEqual(configuration.executorConfig, { model: 'selected' });
  assert.equal(Object.hasOwn(configuration, 'thinkingLevel'), false);
  assert.equal(configuration.collaborationMode, 'agent');
  assert.equal(configuration.orchestrationMode, 'default');
});
