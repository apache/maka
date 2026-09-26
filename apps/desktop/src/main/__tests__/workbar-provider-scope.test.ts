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
import { act, createElement } from 'react';
import type { SessionSummary } from '@maka/core/session';
import { LocaleProvider, type ToastApi } from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeWorkbarServices,
  createWorkbarShellBridge,
  useWorkbarHostModel,
  WorkbarProvider,
  WorkbarServicesProvider,
  WorkbarShellRoot,
  type UseWorkbarControllerInput,
} from '../../renderer/features/workbar/testing.js';

type ShellIntent = Parameters<Parameters<typeof WorkbarShellRoot>[0]['children']>[0];
type HostModel = ReturnType<typeof useWorkbarHostModel>;

let shellRenders = 0;
let hostRenders = 0;
let latestShell: ShellIntent | undefined;
let latestHost: HostModel | undefined;

function HostProbe() {
  latestHost = useWorkbarHostModel();
  hostRenders += 1;
  return null;
}

/** AppShellContent's shape: the projection from the root, the owner below. */
function ShellProbe(props: { workbar: ShellIntent; input: UseWorkbarControllerInput }) {
  latestShell = props.workbar;
  shellRenders += 1;
  return createElement(
    WorkbarProvider,
    { bridge: props.workbar.bridge, input: props.input },
    createElement(HostProbe),
  );
}

const toastApi: ToastApi = {
  toast: () => '',
  success: () => '',
  error: () => '',
  info: () => '',
  warning: () => '',
  confirm: async () => false,
  dismiss: () => {},
};

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

const input: UseWorkbarControllerInput = {
  available: true,
  layoutSessionId: 'a',
  activeSession: session('a'),
  projectId: undefined,
  projectAliases: [],
  authoritativeSessionIds: new Set(['a', 'fork']),
  shellObscured: false,
  modelChoices: [],
  toastApi,
};

function shell(): ShellIntent {
  assert.ok(latestShell);
  return latestShell;
}

function host(): HostModel {
  assert.ok(latestHost);
  return latestHost;
}

afterEach(() => {
  shellRenders = 0;
  hostRenders = 0;
  latestShell = undefined;
  latestHost = undefined;
  cleanupFakeDom();
  delete (globalThis as { window?: unknown }).window;
});

describe('WorkbarProvider render scope', () => {
  it('keeps Workbar updates the shell does not read below the shell', async () => {
    const { root } = installReactRenderer();
    await act(async () =>
      root.render(
        createElement(LocaleProvider, {
          locale: 'en',
          children: createElement(
            WorkbarServicesProvider,
            { services: createFakeWorkbarServices() },
            createElement(WorkbarShellRoot, {
              children: (workbar: ShellIntent) =>
                createElement(ShellProbe, { workbar, input }),
            }),
          ),
        }),
      ),
    );
    assert.equal(shell().selectors.ready, true);

    // The shell's own commands reach the controller through the bridge.
    await act(async () => shell().commands.openTool('review'));
    assert.equal(
      host().panelsState.right.tabs.some((tab) => tab.kind === 'review'),
      true,
    );
    assert.equal(shell().selectors.rightCollapsed, false);

    // Switching tools changes only the host's topology: the shell stays put.
    const shellBeforeSwitch = shellRenders;
    const hostBeforeSwitch = hostRenders;
    await act(async () => shell().commands.openTool('inspector'));
    assert.equal(
      host().panelsState.right.tabs.some((tab) => tab.kind === 'inspector'),
      true,
    );
    assert.equal(hostRenders > hostBeforeSwitch, true);
    assert.equal(shellRenders, shellBeforeSwitch);

    // A hidden companion fork is shell state: the rail and palette filter it.
    const shellBeforeFork = shellRenders;
    await act(async () =>
      host().onForkVisibilityChange?.({ type: 'fork-created', sessionId: 'fork' }),
    );
    assert.equal(shell().selectors.hiddenSessionIds.has('fork'), true);
    assert.equal(shellRenders, shellBeforeFork + 1);

    // So is collapse, which WorkHub's dock reads.
    const shellBeforeCollapse = shellRenders;
    await act(async () => host().onToggleRightPanel());
    assert.equal(shell().selectors.rightCollapsed, true);
    assert.equal(shellRenders, shellBeforeCollapse + 1);

    const { bridge } = shell();
    await act(async () => root.unmount());
    assert.equal(bridge.getState().hiddenSessionIds.size, 0);
    assert.equal(bridge.getState().ready, false);
  });

  it('keeps shell commands safe before the provider publishes', async () => {
    const bridge = createWorkbarShellBridge();
    let notified = 0;
    bridge.subscribe(() => { notified += 1; });
    bridge.commands.openTool('review');
    bridge.commands.toggleRight();
    await bridge.commands.respondToUserForm('a', { requestId: 'form', action: 'cancel' });
    assert.equal(typeof bridge.commands.bindNewTaskSessionResolver(1), 'function');
    bridge.disconnect();
    assert.equal(notified, 0);
  });
});
