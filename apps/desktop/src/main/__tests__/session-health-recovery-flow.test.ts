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
import { parseHTML } from 'linkedom';
import { act, createElement, Fragment, useCallback, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { ProjectedLlmConnection } from '@maka/core/llm-connections';
import type { SessionSummary } from '@maka/core/session';
import {
  Composer,
  deriveComposerModelSwitchAvailability,
  LocaleProvider,
  type ComposerHandle,
} from '@maka/ui';
import { SessionHealthRecoveryNotice } from '../../renderer/chat-recovery-notice.js';
import { useShellChatModel } from '../../renderer/use-shell-chat-model.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

const CONNECTION: ProjectedLlmConnection = {
  connectionId: 'connection-openrouter',
  slug: 'openrouter',
  providerType: 'openrouter',
  name: 'OpenRouter',
  enabled: true,
  defaultModel: 'openai/gpt-5',
  enabledModelIds: ['openai/gpt-5'],
  createdAt: 1,
  updatedAt: 1,
  catalogEntries: [],
};
const CHOICE: ChatModelChoice = {
  connectionId: CONNECTION.connectionId,
  connectionSlug: CONNECTION.slug,
  connectionName: CONNECTION.name,
  providerType: CONNECTION.providerType,
  providerLabel: CONNECTION.name,
  model: CONNECTION.defaultModel,
  label: 'GPT-5',
  isDefault: true,
  thinkingLevels: [],
};
const LEGACY_SESSION = {
  id: 'legacy-session',
  name: 'Legacy',
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  status: 'active',
  backend: 'ai-sdk',
  llmConnectionSlug: CONNECTION.slug,
  connectionLocked: true,
  model: CHOICE.model,
  permissionMode: 'ask',
} satisfies SessionSummary;

let mountedRoot: Root | undefined;

function RecoveryFlow(props: {
  choices: readonly ChatModelChoice[];
  snapshotReady: boolean;
  streaming?: boolean;
  onRefresh: () => void;
  onOpenSettings: (section: string) => void;
}) {
  const composerRef = useRef<ComposerHandle>(null);
  const openModelPicker = useCallback(() => {
    composerRef.current?.openModelPicker();
  }, []);
  const modelSwitchAvailability = deriveComposerModelSwitchAvailability({
    streaming: props.streaming,
    sessionStatus: LEGACY_SESSION.status,
  });
  const { sessionHealthNotice } = useShellChatModel({
    uiLocale: 'en',
    connections: [CONNECTION],
    chatModelChoices: [...props.choices],
    sessionSendOutcome: {
      kind: 'blocked',
      reason: 'legacy_connection_identity',
      connectionLocked: false,
    },
    defaultConnection: CONNECTION.slug,
    newTaskKey: 'test-draft',
    activeSession: LEGACY_SESSION,
    sessionHealthSession: LEGACY_SESSION,
    persistedComposerDefaults: null,
    usePersistedComposerDefaults: false,
    connectionSnapshotReady: props.snapshotReady,
    modelPickerDisabled: !modelSwitchAvailability.available,
    openSettingsSection: props.onOpenSettings,
    openModelPicker,
    refreshModelChoices: props.onRefresh,
  });
  assert.ok(sessionHealthNotice);
  return createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(Fragment, null,
      createElement(SessionHealthRecoveryNotice, {
        notice: sessionHealthNotice,
        fallbackActionLabel: 'Open model settings',
        modelPickerAvailable: true,
      }),
      createElement(Composer, {
        ref: composerRef,
        activeSession: LEGACY_SESSION,
        streaming: props.streaming,
        modelSwitchAvailability,
        modelChoices: [...props.choices],
        hideUnavailableCurrentModel: true,
        onModelChange: () => undefined,
        onSend: () => undefined,
        onStop: () => undefined,
      }),
    ),
  });
}

async function renderFlow(props: Parameters<typeof RecoveryFlow>[0]) {
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>');
  const { document, window } = parsed;
  window.getComputedStyle = () => ({
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Event: window.Event,
    Node: window.Node,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  mountedRoot = createRoot(container);
  await act(() => mountedRoot?.render(createElement(RecoveryFlow, props)));
  const action = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes(
      props.snapshotReady
        ? props.choices.length > 0 ? 'Choose connection and model' : 'Open model settings'
        : 'Reload connections',
    ));
  assert.ok(action);
  return { action, document, window };
}

test('recovery CTA opens the production Composer model picker', async () => {
  const flow = await renderFlow({
    choices: [CHOICE],
    snapshotReady: true,
    onRefresh: assert.fail,
    onOpenSettings: assert.fail,
  });
  await act(() => flow.action.dispatchEvent(new flow.window.Event('click', { bubbles: true })));
  assert.match(flow.document.documentElement.innerHTML, /aria-expanded="true"[^>]*aria-haspopup="menu"/);
});

test('unsettled recovery reloads the catalog without opening the picker', async () => {
  let refreshCount = 0;
  const flow = await renderFlow({
    choices: [CHOICE],
    snapshotReady: false,
    onRefresh: () => { refreshCount += 1; },
    onOpenSettings: assert.fail,
  });
  await act(() => flow.action.dispatchEvent(new flow.window.Event('click', { bubbles: true })));
  assert.equal(refreshCount, 1);
  assert.doesNotMatch(flow.document.documentElement.innerHTML, /aria-expanded="true"[^>]*aria-haspopup="menu"/);
});

test('empty recovery opens Models settings through the production route', async () => {
  const settings: string[] = [];
  const flow = await renderFlow({
    choices: [],
    snapshotReady: true,
    onRefresh: assert.fail,
    onOpenSettings: (section) => settings.push(section),
  });
  await act(() => flow.action.dispatchEvent(new flow.window.Event('click', { bubbles: true })));
  assert.deepEqual(settings, ['models']);
});

test('a live-turn lock disables the recovery CTA and keeps the picker closed', async () => {
  const flow = await renderFlow({
    choices: [CHOICE],
    snapshotReady: true,
    streaming: true,
    onRefresh: assert.fail,
    onOpenSettings: assert.fail,
  });
  assert.equal(flow.action.disabled, true);
  await act(() => flow.action.dispatchEvent(new flow.window.Event('click', { bubbles: true })));
  assert.doesNotMatch(flow.document.documentElement.innerHTML, /aria-expanded="true"[^>]*aria-haspopup="menu"/);
});

afterEach(async () => {
  if (mountedRoot) {
    await act(() => mountedRoot?.unmount());
  }
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});
