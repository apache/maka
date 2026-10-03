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
import { useExecutorSelection, createExecutorSessionActivator, ConversationServicesProvider, type ConversationServices } from '../../renderer/features/conversation/index.js';
import { executorComposerProps, executorSubmissionError, newTaskConfiguration } from '../../renderer/features/conversation/testing.js';

const entry: ExecutorCatalogEntry = { id: 'external', displayName: 'External', readiness: 'ready', models: [{ id: 'selected', name: 'Selected' }], supportsAttachments: false, supportsModelChange: true };

test('first send carries the selected catalog through inspection and Agent initialization', async () => {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const values = { document, window, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  const discovered: ExecutorCatalogEntry = {
    ...entry,
    models: [{ id: 'selected', name: 'Gemini High' }, { id: 'low', name: 'Gemini Low' }, { id: 'default', name: 'Default model' }],
    modelGroups: [{ id: 'gemini', name: 'Gemini', variants: [{ modelId: 'selected', level: 'high' }, { modelId: 'low', level: 'low' }] }],
    modes: [{ id: 'default', name: 'Default' }], currentMode: 'default', supportsModeChange: true,
    currentModel: 'default',
  };
  let latest!: ReturnType<typeof useExecutorSelection>;
  const frames: Array<ReturnType<typeof useExecutorSelection>> = [];
  let finishInspection!: (value: readonly ExecutorCatalogEntry[]) => void;
  const pending = new Promise<readonly ExecutorCatalogEntry[]>(resolve => { finishInspection = resolve; });
  let inspection = pending;
  let observed: readonly ExecutorCatalogEntry[] | undefined;
  let sessionPending = false;
  let inspectionCalls = 0;
  const services = {
    subscribeChanges: () => () => {},
    newTasks: { subscribeChanges: () => () => {}, getExecutors: async () => [discovered] },
    sessions: { getExecutorState: () => {
      inspectionCalls++;
      if (sessionPending) throw new Error('Session not found');
      return observed ? Promise.resolve(observed) : inspection;
    } },
  } as unknown as ConversationServices;
  const session = { id: 'created', executorId: 'external', model: 'selected', executorConfig: { model: 'selected' } } as SessionSummary;
  function Probe(props: { session?: SessionSummary }) {
    latest = useExecutorSelection({ key: 'draft', cwd: '/fixture', target: { hostId: 'host', profileId: 'profile', projectId: null }, session: props.session, ...{ sessionPending } });
    frames.push(latest);
    return null;
  }
  const render = async (value?: SessionSummary) => {
    await act(async () => root.render(createElement(ConversationServicesProvider, { services, children: createElement(Probe, { session: value }) })));
  };
  const assertDisplay = () => {
    assert.equal(latest.selection?.configuration.model, 'selected');
    assert.equal(latest.entry?.displayName, 'External');
    assert.deepEqual(latest.entry?.modelGroups, discovered.modelGroups);
    assert.deepEqual(latest.entry?.modes, discovered.modes);
    assert.equal(latest.selection?.configuration.mode, 'default');
    assert.equal(latest.error, undefined);
  };
  try {
    await render();
    await act(async () => latest.select({ executorId: 'external', configuration: { model: 'selected' } }));
    const sending = executorComposerProps(latest, { activeId: undefined, turnActive: false, sendPending: true, taskSubmissionHardBlocked: false, connectionCount: 0, onSetup() {}, onNewTask() {} });
    assert.equal(sending.executorPicker?.disabled, true, 'controls lock before Host admission');
    assert.equal(sending.sendBlocked, true, 'Session handoff cannot admit a duplicate first send');
    const localSession = { ...session, model: 'external', executorConfig: undefined };
    const activation: string[] = [];
    await createExecutorSessionActivator(latest, () => {
      activation.push('commit');
    }, selection => {
      assert.equal(selection.section, 'sessions');
      activation.push('navigation');
    }, id => {
      assert.equal(id, localSession.id);
      activation.push('activate');
    })(localSession);
    assert.deepEqual(activation, ['commit', 'navigation', 'activate']);
    assert.equal(latest.entry?.displayName, 'External', 'adoption does not erase the still-visible draft');
    const start = frames.length;
    sessionPending = true;
    await render(localSession);
    assert.equal(inspectionCalls, 0, 'a locally pending Session must not inspect a nonexistent Host Session');
    assert.equal(latest.loading, true);
    assertDisplay();
    await act(async () => latest.refresh(true));
    assert.equal(inspectionCalls, 0, 'catalog invalidations cannot bypass local admission');
    assertDisplay();
    sessionPending = false;
    await render(session);
    assert.equal(latest.loading, true);
    assertDisplay();
    await act(async () => {
      finishInspection([{ ...entry, models: [{ id: 'selected', name: 'selected' }], currentModel: 'selected', supportsModelChange: false }]);
      await pending;
    });
    assertDisplay();
    assert.equal(latest.entry?.supportsModelChange, false, 'presentation does not invent Session capabilities');
    observed = [{ ...entry, models: [{ id: 'selected', name: 'selected' }], currentModel: 'selected', supportsModelChange: false,
      modes: discovered.modes, currentMode: 'default', supportsModeChange: true }];
    await act(async () => latest.refresh());
    assertDisplay();
    assert.equal(latest.entry?.supportsModeChange, true, 'mode readiness does not erase pending model presentation');
    observed = [discovered];
    await act(async () => latest.refresh());
    assertDisplay();
    observed = [{ ...entry, models: [{ id: 'selected', name: 'selected' }], currentModel: 'selected', supportsModelChange: false }];
    await act(async () => latest.refresh());
    assertDisplay();
    assert.equal(latest.entry?.supportsModelChange, false, 'a later configuration-only inspection keeps its real capabilities');
    observed = [discovered];
    await render({ ...session, executorConfig: undefined });
    assert.equal(latest.selection?.configuration.model, 'default', 'a Host Session without explicit config follows inspection');
    await render(session);
    assertDisplay();
    assert.ok(frames.slice(start).every(frame => frame.entry?.models.some(model => model.id === frame.selection?.configuration.model)), 'no committed frame loses its selected model metadata');
    observed = [{ ...discovered, models: [{ id: 'default', name: 'Default model' }], modelGroups: [], modes: [], supportsModeChange: false }];
    await act(async () => latest.refresh());
    assert.deepEqual(latest.catalog, observed, 'an authoritative removal must not be hidden by known presentation');
    observed = [{ ...entry, readiness: 'unavailable', models: [] }];
    await act(async () => latest.refresh());
    assert.equal(latest.entry?.readiness, 'unavailable', 'real failure replaces the initial presentation');
    observed = undefined;
    inspection = new Promise(() => {});
    await render({ ...session, id: 'other-session' });
    assert.equal(latest.entry, undefined, 'another Session cannot inherit the submitted draft catalog');
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test('a plugin without discovery accepts followups while pending local summaries retain their model', async () => {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const values = { document, window, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  let latest!: ReturnType<typeof useExecutorSelection>;
  const services = {
    subscribeChanges: () => () => {},
    newTasks: { subscribeChanges: () => () => {} },
    sessions: { getExecutorState: async () => [{ ...entry, models: [], supportsModelChange: false }] },
  } as unknown as ConversationServices;
  const session = { id: 'saved', executorId: 'external', model: 'workhub-default' } as SessionSummary;
  function Probe(props: { sessionPending: boolean; session: SessionSummary }) {
    latest = useExecutorSelection({ key: 'saved', ...props });
    return null;
  }
  const render = async (sessionPending: boolean, value = session) => {
    await act(async () => root.render(createElement(ConversationServicesProvider, {
      services, children: createElement(Probe, { sessionPending, session: value }),
    })));
  };
  try {
    await render(true);
    assert.equal(latest.selection?.configuration.model, 'workhub-default');
    await render(false);
    assert.deepEqual(latest.selection?.configuration, {});
    assert.equal(executorSubmissionError({ executorSelection: latest.selection, executorEntry: latest.entry }, 0, 'en'), undefined);
    await render(false, { ...session, executorConfig: { model: 'removed-model' } });
    assert.match(executorSubmissionError({ executorSelection: latest.selection, executorEntry: latest.entry }, 0, 'en') ?? '', /no longer available/);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

for (const modeState of ['removed', 'replaced', 'valid', 'unknown-model', 'unknown-capability'] as const) {
  test(`explicit restore recovers a ${modeState} mode only when inspection confirms its removal`, async () => {
    const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
    const values = { document, window, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
    const originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const root = createRoot(document.getElementById('root')!);
    let latest!: ReturnType<typeof useExecutorSelection>;
    const configuration = { model: 'selected', mode: 'ask' };
    const expected = modeState === 'removed' ? { model: 'selected' }
      : modeState === 'replaced' ? { model: 'selected', mode: 'auto' } : configuration;
    const writes: unknown[] = [];
    let ready = false;
    const services = {
      subscribeChanges: () => () => {},
      newTasks: { subscribeChanges: () => () => {} },
      sessions: {
        getExecutorState: async () => [{
          ...entry, readiness: ready ? 'ready' : 'restore_failed',
          currentModel: modeState === 'unknown-model' && !ready ? 'other' : 'selected',
          // ACP inspection may retain a saved mode label despite losing the option.
          modes: [{ id: modeState === 'replaced' ? 'auto' : 'ask', name: 'Mode' }],
          supportsModeChange: modeState === 'unknown-capability' ? undefined : modeState !== 'removed',
        }],
        setExecutorModelConfiguration: async (_id: string, config: unknown) => {
          writes.push(config);
          ready = true;
          return { ok: true, session: { executorConfig: expected } };
        },
      },
    } as unknown as ConversationServices;
    function Probe() {
      latest = useExecutorSelection({ key: 'saved', session: { id: 'saved', executorId: 'external', executorConfig: configuration } as SessionSummary });
      return null;
    }
    try {
      await act(async () => root.render(createElement(ConversationServicesProvider, { services, children: createElement(Probe) })));
      assert.equal(latest.entry?.readiness, 'restore_failed');
      await act(async () => latest.restore());
      assert.deepEqual(writes, [modeState === 'removed' || modeState === 'replaced' ? { model: 'selected' } : configuration]);
      assert.deepEqual(latest.selection?.configuration, expected);
      assert.equal(latest.entry?.readiness, 'ready');
      assert.equal(executorSubmissionError({ executorSelection: latest.selection, executorEntry: latest.entry }, 0, 'en'), undefined);
    } finally {
      await act(async () => root.unmount());
      for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  });
}

test('explicit restore confirms the saved model while preserving the current task', async () => {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const values = { document, window, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  let latest!: ReturnType<typeof useExecutorSelection>;
  let ready = false;
  let finishRestore!: () => void;
  const confirmation = new Promise<void>((resolve) => { finishRestore = resolve; });
  const writes: Array<{ sessionId: string; model: string | undefined }> = [];
  const services = {
    subscribeChanges: () => () => {},
    newTasks: { subscribeChanges: () => () => {}, getExecutors: async () => [entry] },
    sessions: {
      getExecutorState: async () => [{ ...entry, readiness: ready ? 'ready' : 'restorable', currentModel: 'selected' }],
      setExecutorModelConfiguration: async (sessionId: string, config: { model?: string }) => {
        writes.push({ sessionId, model: config.model });
        await confirmation;
        ready = true;
        return { ok: true, session: { executorConfig: config } };
      },
    },
  } as unknown as ConversationServices;
  function Probe() {
    latest = useExecutorSelection({
      key: 'saved', cwd: '/fixture',
      target: { hostId: 'host', profileId: 'profile', projectId: null },
      session: { id: 'saved', executorId: 'external', executorConfig: { model: 'selected' } } as SessionSummary,
    });
    return null;
  }
  try {
    await act(async () => root.render(createElement(ConversationServicesProvider, { services, children: createElement(Probe) })));
    assert.equal(latest.entry?.readiness, 'restorable');
    let restoring!: Promise<void>;
    await act(async () => { restoring = latest.restore(); });
    assert.equal(latest.entry?.readiness, 'restoring');
    await act(async () => { finishRestore(); await restoring; });
    assert.deepEqual(writes, [{ sessionId: 'saved', model: 'selected' }]);
    assert.equal(latest.entry?.readiness, 'ready');
    assert.equal(latest.selection?.executorId, 'external');
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

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
      await assert.rejects(latest.restore(), /pending/);
      assert.equal(latest.entry?.readiness, 'ready', 'a rejected restore is not shown as active');
      serverModel = 'fast';
      confirm({ ok: true, session: { executorConfig: { model: 'fast' } } });
      await pending;
    });
    assert.equal(latest.selection?.configuration.model, 'fast', 'confirmed state replaces stale Session props');
    assert.equal(latest.changing, false);
    serverModel = 'selected';
    await act(async () => latest.refresh());
    assert.equal(latest.entry?.currentModel, 'selected', 'inspection still reports observed Agent state');
    assert.equal(latest.selection?.configuration.model, 'fast', 'Agent drift cannot replace the confirmed selection');
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

test('a late Agent mode update cannot replace the saved task selection', async () => {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const values = { document, window, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  const modes = [{ id: 'ask', name: 'Ask' }, { id: 'auto', name: 'Auto' }];
  let observedMode = 'auto';
  let latest!: ReturnType<typeof useExecutorSelection>;
  const services = {
    subscribeChanges: () => () => {},
    newTasks: { subscribeChanges: () => () => {} },
    sessions: {
      getExecutorState: async () => [{ ...entry, modes, currentModel: 'selected', currentMode: observedMode }],
      setExecutorModelConfiguration: async () => ({
        ok: true,
        session: { executorConfig: { model: 'selected', mode: 'auto' } },
      }),
    },
  } as unknown as ConversationServices;
  const session = { id: 'saved', executorId: 'external', executorConfig: { model: 'selected', mode: 'ask' } } as SessionSummary;
  function Probe(props: { session: SessionSummary }) {
    latest = useExecutorSelection({ key: 'saved', session: props.session });
    return null;
  }
  try {
    await act(async () => root.render(createElement(ConversationServicesProvider, { services, children: createElement(Probe, { session }) })));
    assert.equal(latest.entry?.currentMode, 'auto');
    assert.equal(latest.selection?.configuration.mode, 'ask', 'saved mode remains selected after Agent drift');
    await act(async () => latest.select({ executorId: 'external', configuration: { mode: 'auto' } }));
    assert.equal(latest.selection?.configuration.mode, 'auto', 'confirmed change is visible before Session props catch up');
    observedMode = 'ask';
    await act(async () => latest.refresh());
    assert.equal(latest.entry?.currentMode, 'ask');
    assert.equal(latest.selection?.configuration.mode, 'auto', 'another late update cannot replace the confirmed choice');
    await act(async () => root.render(createElement(ConversationServicesProvider, { services, children: createElement(Probe, { session: { ...session, executorConfig: { model: 'selected', mode: 'auto' } } }) })));
    assert.equal(latest.selection?.configuration.mode, 'auto');
    await act(async () => root.render(createElement(ConversationServicesProvider, { services, children: createElement(Probe, { session }) })));
    assert.equal(latest.selection?.configuration.mode, 'ask', 'a later saved configuration supersedes the local confirmation');
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

test('draft submission keeps the selected mode and blocks a removed catalog choice', () => {
  const executorSelection = { executorId: 'external', configuration: { model: 'selected', mode: 'auto' } };
  const configuration = newTaskConfiguration({
    executorSelection,
    newChatModel: null, pendingNewChatThinkingLevel: undefined,
    newChatPermissionChoice: undefined, newChatCollaborationMode: 'agent',
    newChatOrchestrationMode: 'default',
  });
  assert.deepEqual(configuration.executorConfig, { model: 'selected', mode: 'auto' });
  assert.match(executorSubmissionError({
    executorSelection,
    executorEntry: { ...entry, modes: [{ id: 'ask', name: 'Ask' }] },
  }, 0, 'en') ?? '', /no longer available/u);
});
