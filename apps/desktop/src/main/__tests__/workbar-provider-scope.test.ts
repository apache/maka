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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement, Fragment } from 'react';
import type { SessionSummary } from '@maka/core/session';
import { LocaleProvider } from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeWorkbarServices,
  createWorkbarShellBridge,
  useWorkbarHostModel,
  useWorkbarTitlebarModel,
  WorkbarProvider,
  WorkbarServicesProvider,
  type UseWorkbarControllerInput,
  type WorkbarHostModel,
  type WorkbarServices,
  type WorkbarShellBridge,
  type WorkbarTitlebarModel,
} from '../../renderer/features/workbar/testing.js';

let shellRenders = 0;
let hostRenders = 0;
let titlebarRenders = 0;
let latestHost: WorkbarHostModel | undefined;
let latestTitlebar: WorkbarTitlebarModel | undefined;

function HostProbe() {
  latestHost = useWorkbarHostModel();
  hostRenders += 1;
  return null;
}

function TitlebarProbe() {
  latestTitlebar = useWorkbarTitlebarModel();
  titlebarRenders += 1;
  return null;
}

function ShellProbe() {
  shellRenders += 1;
  return createElement(
    Fragment,
    null,
    createElement(HostProbe),
    createElement(TitlebarProbe),
  );
}

function session(id: string): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: false,
    model: 'test-model',
    permissionMode: 'ask',
  };
}

function input(activeSession: SessionSummary): UseWorkbarControllerInput {
  return {
    available: true,
    activeSession,
    projectId: activeSession.projectId,
    projectAliases: [],
    authoritativeSessionIds: new Set([activeSession.id, 'fork']),
    shellObscured: false,
    modelChoices: [],
    reportError: () => undefined,
  };
}

function renderProvider(
  root: ReturnType<typeof installReactRenderer>['root'],
  services: WorkbarServices,
  bridge: WorkbarShellBridge,
) {
  root.render(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(
        WorkbarServicesProvider,
        { services },
        createElement(
          WorkbarProvider,
          { ...input(session('a')), bridge },
          createElement(ShellProbe),
        ),
      ),
    }),
  );
}

afterEach(() => {
  shellRenders = 0;
  hostRenders = 0;
  titlebarRenders = 0;
  latestHost = undefined;
  latestTitlebar = undefined;
  cleanupFakeDom();
  delete (globalThis as { window?: unknown }).window;
});

describe('WorkbarProvider render scope', () => {
  it('keeps controller updates below the shell and publishes its narrow bridge', async () => {
    const { root } = installReactRenderer();
    const bridge = createWorkbarShellBridge();
    let visibilityNotifications = 0;
    const unsubscribe = bridge.hiddenSessionIds.subscribe(() => {
      visibilityNotifications += 1;
    });

    await act(async () =>
      renderProvider(root, createFakeWorkbarServices(), bridge),
    );
    assert.equal(shellRenders, 1);
    assert.equal(latestTitlebar?.available, true);

    const initiallyCollapsed = bridge.getRightCollapsed();
    const hostBeforeToggle = hostRenders;
    const titlebarBeforeToggle = titlebarRenders;
    await act(async () => latestTitlebar?.onToggle());
    assert.equal(bridge.getRightCollapsed(), !initiallyCollapsed);
    assert.equal(shellRenders, 1);
    assert.equal(hostRenders, hostBeforeToggle + 1);
    assert.equal(titlebarRenders, titlebarBeforeToggle + 1);

    await act(async () => bridge.commands.openTool('review'));
    assert.equal(
      latestHost?.panelsState.right.tabs.some((tab) => tab.kind === 'review'),
      true,
    );
    assert.equal(shellRenders, 1);

    await act(async () =>
      latestHost?.onForkVisibilityChange?.({
        type: 'fork-created',
        sessionId: 'fork',
      }),
    );
    assert.equal(bridge.hiddenSessionIds.getState().has('fork'), true);
    assert.equal(visibilityNotifications, 1);
    assert.equal(shellRenders, 1);

    unsubscribe();
    await act(async () => root.unmount());
    assert.equal(bridge.hiddenSessionIds.getState().size, 0);
  });
});
