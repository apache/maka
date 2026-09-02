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
import type { SessionSummary } from '@maka/core/session';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  SessionSettingsServicesProvider,
  type SessionSettingsServices,
  useSessionSettingIntent,
} from '../../renderer/features/session-settings/index.js';

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
        return {} as SessionSummary;
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
        return {} as SessionSummary;
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
        } as SessionSummary;
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
    } as SessionSummary],
    services: createServices({
      setModelConfiguration: async (sessionId, input) => {
        writes.push({ sessionId, input });
        return {
          llmConnectionId: input.llmConnectionId,
          llmConnectionSlug: input.llmConnectionSlug,
          model: input.model,
          thinkingLevel: input.thinkingLevel,
        } as SessionSummary;
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

async function mountController(overrides: {
  services?: SessionSettingsServices;
  owner?: { sessionId?: string };
  sessions?: readonly SessionSummary[];
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
  sessions: readonly SessionSummary[];
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

function createServices(
  overrides: Partial<SessionSettingsServices> = {},
): SessionSettingsServices {
  return {
    setModelConfiguration: async () => ({} as SessionSummary),
    setPermissionMode: async () => ({} as SessionSummary),
    setOrchestrationMode: async () => ({} as SessionSummary),
    ...overrides,
  };
}
