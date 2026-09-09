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
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  SessionSettingsServicesProvider,
  type SessionSettingsServices,
  useSessionSettingIntent,
} from '../../renderer/features/session-settings/index.js';
import { reconcileRuntimeHostSessionCatalog } from '../../preload/runtime-host-session-catalog.js';
import type { DesktopSessionSummary } from '../../shared/desktop-session-projection.js';

type Controller = ReturnType<typeof useSessionSettingIntent<{ sessionId?: string }>>;

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

test('rejects non-chat permission modes before confirmation or persistence', async () => {
  let permissionWrites = 0;
  let draftWrites = 0;
  let confirmations = 0;
  const { controller } = await mountController({
    services: createServices({
      setPermissionMode: async () => {
        permissionWrites += 1;
        return {} as DesktopSessionSummary;
      },
    }),
    setNewTaskPermissionMode: () => {
      draftWrites += 1;
    },
    confirmBypass: async () => {
      confirmations += 1;
      return true;
    },
  });

  let accepted = true;
  await act(async () => {
    accepted = await controller().setPermissionMode('explore');
  });

  assert.equal(accepted, false);
  assert.equal(permissionWrites, 0);
  assert.equal(draftWrites, 0);
  assert.equal(confirmations, 0);
});

test('rejects non-chat permission modes before writing an existing Session', async () => {
  let permissionWrites = 0;
  const { controller } = await mountController({
    owner: { sessionId: 'session-1' },
    services: createServices({
      setPermissionMode: async () => {
        permissionWrites += 1;
        return {} as DesktopSessionSummary;
      },
    }),
  });

  let accepted = true;
  await act(async () => {
    accepted = await controller().setPermissionMode('explore');
  });

  assert.equal(accepted, false);
  assert.equal(permissionWrites, 0);
});

test('persists a model selection as one compound configuration and saves its default', async () => {
  const writes: unknown[] = [];
  const savedDefaults: unknown[] = [];
  const { controller } = await mountController({
    services: createServices({
      setModelConfiguration: async (sessionId, input) => {
        writes.push({ sessionId, input });
        return {
          llmConnectionId: input.llmConnectionId,
          llmConnectionSlug: input.llmConnectionSlug,
          model: input.model,
          thinkingLevel: input.thinkingLevel,
          revision: 1,
        } as DesktopSessionSummary;
      },
    }),
    saveComposerDefaults: (model) => savedDefaults.push(model),
  });

  let committed = false;
  await act(async () => {
    committed = await controller().setSessionModel('session-1', {
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai',
      model: 'gpt-5',
    });
  });

  assert.equal(committed, true);
  assert.deepEqual(writes, [{
    sessionId: 'session-1',
    input: {
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai',
      model: 'gpt-5',
      thinkingLevel: null,
    },
  }]);
  assert.deepEqual(savedDefaults, [{
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'openai',
    model: 'gpt-5',
  }]);
});

test('persists a thinking selection through the same compound configuration service', async () => {
  const writes: unknown[] = [];
  const savedDefaults: unknown[] = [];
  const { controller } = await mountController({
    sessions: [{
      id: 'session-1',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai',
      model: 'gpt-5',
      revision: 1,
    } as DesktopSessionSummary],
    services: createServices({
      setModelConfiguration: async (sessionId, input) => {
        writes.push({ sessionId, input });
        return {
          llmConnectionId: input.llmConnectionId,
          llmConnectionSlug: input.llmConnectionSlug,
          model: input.model,
          thinkingLevel: input.thinkingLevel,
          revision: 2,
        } as DesktopSessionSummary;
      },
    }),
    saveComposerDefaults: (model) => savedDefaults.push(model),
  });

  let committed = false;
  await act(async () => {
    committed = await controller().setSessionThinkingLevel('session-1', 'high');
  });

  assert.equal(committed, true);
  assert.deepEqual(writes, [{
    sessionId: 'session-1',
    input: {
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai',
      model: 'gpt-5',
      thinkingLevel: 'high',
    },
  }]);
  assert.deepEqual(savedDefaults, []);
});

test('retains the Model overlay while a partial Host catalog still has the prior Session revision', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;

  const targetBeforeWrite = desktopSession({
    id: 'session-a',
    runtimeHostId: 'host-a',
    profileId: 'profile-a',
    revision: 1,
    activityAt: 10,
    model: 'model-a',
  });
  const otherHostSession = desktopSession({
    id: 'session-b',
    runtimeHostId: 'host-b',
    profileId: 'profile-b',
    revision: 1,
    activityAt: 9,
    model: 'model-b',
  });
  const targetAfterWrite = {
    ...targetBeforeWrite,
    revision: 2,
    llmConnectionId: 'connection-c',
    llmConnectionSlug: 'openai',
    model: 'model-c',
  };
  let controller: Controller | undefined;
  const render = async (catalogRevision: number, sessions: readonly DesktopSessionSummary[]) => {
    await act(async () => {
      root.render(createElement(
        SessionSettingsServicesProvider,
        {
          services: createServices({
            setModelConfiguration: async () => targetAfterWrite,
          }),
        },
        createElement(CausalRetirementHarness, {
          capture: (next) => {
            controller = next;
          },
          catalogRevision,
          sessions,
        }),
      ));
    });
  };

  await render(0, [targetBeforeWrite, otherHostSession]);
  await act(async () => {
    assert.equal(await controller!.setSessionModel('session-a', {
      llmConnectionId: 'connection-c',
      llmConnectionSlug: 'openai',
      model: 'model-c',
    }), true);
  });
  assert.equal(controller!.overlays.modelConfiguration['session-a']?.modelTarget.model, 'model-c');

  // Host B advances the renderer-wide catalog while unavailable Host A retains
  // its old row. That global advance is not evidence that Host A observed the write.
  const partialCatalog = reconcileRuntimeHostSessionCatalog(
    [targetBeforeWrite, otherHostSession],
    {
      sessions: [{ ...otherHostSession, revision: 2, activityAt: 20 }],
      completeHostIds: ['host-b'],
      knownOwnerProfileIds: ['profile-a', 'profile-b'],
    },
  );
  assert.equal(partialCatalog.find((session) => session.id === 'session-a')?.revision, 1);
  assert.equal(partialCatalog.find((session) => session.id === 'session-b')?.revision, 2);
  await render(1, partialCatalog);
  assert.equal(controller!.overlays.modelConfiguration['session-a']?.modelTarget.model, 'model-c');

  const caughtUpCatalog = reconcileRuntimeHostSessionCatalog(partialCatalog, {
    sessions: [
      { ...otherHostSession, revision: 2, activityAt: 20 },
      { ...targetAfterWrite, activityAt: 21 },
    ],
    completeHostIds: ['host-a', 'host-b'],
    knownOwnerProfileIds: ['profile-a', 'profile-b'],
  });
  assert.equal(caughtUpCatalog.find((session) => session.id === 'session-a')?.revision, 2);
  await render(2, caughtUpCatalog);
  assert.equal(controller!.overlays.modelConfiguration['session-a'], undefined);
});

test('retires Permission and Orchestration overlays by their committed Session revisions', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;

  const targetBeforeWrite = {
    ...desktopSession({
      id: 'session-a',
      runtimeHostId: 'host-a',
      profileId: 'profile-a',
      revision: 1,
      activityAt: 10,
      model: 'model-a',
    }),
    permissionMode: 'ask' as const,
    orchestrationMode: 'default' as const,
  };
  const otherHostSession = desktopSession({
    id: 'session-b',
    runtimeHostId: 'host-b',
    profileId: 'profile-b',
    revision: 1,
    activityAt: 9,
    model: 'model-b',
  });
  const targetAfterPermission = {
    ...targetBeforeWrite,
    revision: 2,
    permissionMode: 'bypass' as const,
  };
  const targetAfterOrchestration = {
    ...targetAfterPermission,
    revision: 3,
    orchestrationMode: 'swarm' as const,
  };
  let controller: Controller | undefined;
  const render = async (catalogRevision: number, sessions: readonly DesktopSessionSummary[]) => {
    await act(async () => {
      root.render(createElement(
        SessionSettingsServicesProvider,
        {
          services: createServices({
            setPermissionMode: async () => targetAfterPermission,
            setOrchestrationMode: async () => targetAfterOrchestration,
          }),
        },
        createElement(CausalRetirementHarness, {
          capture: (next) => {
            controller = next;
          },
          catalogRevision,
          sessions,
        }),
      ));
    });
  };

  await render(0, [targetBeforeWrite, otherHostSession]);
  await act(async () => {
    assert.equal(await controller!.setPermissionMode('bypass'), true);
    assert.equal(await controller!.setOrchestrationMode('session-a', 'swarm'), true);
  });
  assert.equal(controller!.overlays.permissionMode['session-a'], 'bypass');
  assert.equal(controller!.overlays.orchestrationMode['session-a'], 'swarm');

  const partialCatalog = reconcileRuntimeHostSessionCatalog(
    [targetBeforeWrite, otherHostSession],
    {
      sessions: [{ ...otherHostSession, revision: 2, activityAt: 20 }],
      completeHostIds: ['host-b'],
      knownOwnerProfileIds: ['profile-a', 'profile-b'],
    },
  );
  await render(1, partialCatalog);
  assert.equal(controller!.overlays.permissionMode['session-a'], 'bypass');
  assert.equal(controller!.overlays.orchestrationMode['session-a'], 'swarm');

  await render(2, [targetAfterPermission, otherHostSession]);
  assert.equal(controller!.overlays.permissionMode['session-a'], undefined);
  assert.equal(controller!.overlays.orchestrationMode['session-a'], 'swarm');

  await render(3, [targetAfterOrchestration, otherHostSession]);
  assert.equal(controller!.overlays.orchestrationMode['session-a'], undefined);
});

test('rejects an Orchestration write whose returned summary has a different mode', async () => {
  const session = {
    ...desktopSession({
      id: 'session-1',
      runtimeHostId: 'host-a',
      profileId: 'profile-a',
      revision: 1,
      activityAt: 10,
      model: 'model-a',
    }),
    orchestrationMode: 'default' as const,
  };
  const { controller } = await mountController({
    sessions: [session],
    services: createServices({
      setOrchestrationMode: async () => ({ ...session, revision: 2 }),
    }),
  });

  let accepted = true;
  await act(async () => {
    accepted = await controller().setOrchestrationMode('session-1', 'swarm');
  });

  assert.equal(accepted, false);
  assert.equal(controller().overlays.orchestrationMode['session-1'], undefined);
});

async function mountController(overrides: {
  services?: SessionSettingsServices;
  owner?: { sessionId?: string };
  sessions?: readonly DesktopSessionSummary[];
  setNewTaskPermissionMode?(mode: 'ask' | 'bypass'): void;
  confirmBypass?(): Promise<boolean>;
  saveComposerDefaults?(model: {
    llmConnectionId: string;
    llmConnectionSlug: string;
    model: string;
  }): void;
} = {}): Promise<{ controller(): Controller }> {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  let captured: Controller | undefined;

  await act(async () => {
    root.render(createElement(
      SessionSettingsServicesProvider,
      { services: overrides.services ?? createServices() },
      createElement(Harness, {
        capture: (controller: Controller) => {
          captured = controller;
        },
        owner: overrides.owner ?? {},
        sessions: overrides.sessions ?? [],
        setNewTaskPermissionMode: overrides.setNewTaskPermissionMode ?? (() => {}),
        confirmBypass: overrides.confirmBypass ?? (async () => true),
        saveComposerDefaults: overrides.saveComposerDefaults ?? (() => {}),
      }),
    ));
  });

  return {
    controller: () => {
      assert.ok(captured);
      return captured;
    },
  };
}

function Harness(props: {
  capture(controller: Controller): void;
  owner: { sessionId?: string };
  sessions: readonly DesktopSessionSummary[];
  setNewTaskPermissionMode(mode: 'ask' | 'bypass'): void;
  confirmBypass(): Promise<boolean>;
  saveComposerDefaults(model: {
    llmConnectionId: string;
    llmConnectionSlug: string;
    model: string;
  }): void;
}) {
  const controller = useSessionSettingIntent({
    catalogRevision: 0,
    isActiveSession: () => true,
    sessions: props.sessions,
    newTaskPermissionMode: 'ask',
    refreshCatalog: async () => {},
    saveComposerDefaults: props.saveComposerDefaults,
    writeFailureCopy: () => ({ title: 'failed', description: 'failed' }),
    showSessionError: () => {},
    planMode: { write: async () => true },
    captureOwner: () => props.owner,
    isOwnerActive: () => true,
    setNewTaskPermissionMode: props.setNewTaskPermissionMode,
    confirmBypass: props.confirmBypass,
  });
  props.capture(controller);
  return null;
}

function CausalRetirementHarness(props: {
  capture(controller: Controller): void;
  catalogRevision: number;
  sessions: readonly DesktopSessionSummary[];
}) {
  const controller = useSessionSettingIntent({
    catalogRevision: props.catalogRevision,
    isActiveSession: () => true,
    sessions: props.sessions,
    newTaskPermissionMode: 'ask',
    refreshCatalog: async () => {},
    saveComposerDefaults: () => {},
    writeFailureCopy: () => ({ title: 'failed', description: 'failed' }),
    showSessionError: () => {},
    planMode: { write: async () => true },
    captureOwner: () => ({ sessionId: 'session-a' }),
    isOwnerActive: () => true,
    setNewTaskPermissionMode: () => {},
    confirmBypass: async () => true,
  });
  props.capture(controller);
  return null;
}

function desktopSession(input: {
  id: string;
  runtimeHostId: string;
  profileId: string;
  revision: number;
  activityAt: number;
  model: string;
}): DesktopSessionSummary {
  return {
    id: input.id,
    runtimeHostId: input.runtimeHostId,
    profileId: input.profileId,
    profileName: input.profileId,
    profileKind: 'local',
    revision: input.revision,
    activityAt: input.activityAt,
    llmConnectionId: 'connection-a',
    llmConnectionSlug: 'openai',
    model: input.model,
  } as DesktopSessionSummary;
}

function createServices(
  overrides: Partial<SessionSettingsServices> = {},
): SessionSettingsServices {
  return {
    setModelConfiguration: async () => ({} as DesktopSessionSummary),
    setPermissionMode: async () => ({} as DesktopSessionSummary),
    setOrchestrationMode: async () => ({} as DesktopSessionSummary),
    ...overrides,
  };
}
