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

/**
 * The default working directory is a client-owned, local-only preference. A
 * remote Runtime Host advertises `setLocalDefault: false` and its
 * ProjectRootController never receives the callback, so offering the control
 * there would let a user save a path the target is incapable of using. These
 * tests pin the capability gate, and pin the save to the client-owned
 * (per-machine) `projects` section rather than anything Host-shared.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LocaleProvider, ToastProvider } from '@maka/ui';
import type { UpdateAppSettingsInput } from '@maka/core/settings';
import type {
  DesktopProjectCapabilities,
  DesktopRuntimeHostRef,
} from '../../preload/bridge-contract.js';
import {
  DefaultWorkingDirectoryRow,
  useLocalDefaultCapability,
} from '../../renderer/settings/default-working-directory-row.js';

const TEST_RUNTIME_HOST: DesktopRuntimeHostRef = {
  profileId: 'test-profile',
  hostId: 'test-host',
};

const CONFIGURED_DIRECTORY = '/Users/example/agent';
const CHOSEN_DIRECTORY = '/Users/example/picked';

const LOCAL_CAPABILITIES: DesktopProjectCapabilities = {
  chooseClientDirectory: true,
  chooseHostDirectory: false,
  selectNoProject: true,
  setLocalDefault: true,
  viewClientPath: true,
};

const REMOTE_CAPABILITIES: DesktopProjectCapabilities = {
  chooseClientDirectory: false,
  chooseHostDirectory: true,
  selectNoProject: false,
  setLocalDefault: false,
  viewClientPath: false,
};

interface RowHarness {
  container: HTMLElement;
  root: Root;
  patches: UpdateAppSettingsInput[];
  pickerCalls(): number;
  gateStates: boolean[];
}

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

afterEach(() => {
  Object.assign(globalThis, originalGlobals);
});

test('a local Runtime Host may set the directory, and its current value is shown', async () => {
  const harness = await renderRow({ capabilities: LOCAL_CAPABILITIES });

  assert.deepEqual(harness.gateStates.at(-1), true);
  assert.match(harness.container.textContent ?? '', /Default working directory/);
  assert.match(harness.container.textContent ?? '', new RegExp(CONFIGURED_DIRECTORY));
  assert.ok(buttonWithLabel(harness.container, 'Choose folder'));

  await unmount(harness);
});

test('a remote Runtime Host cannot set a local-only default', async () => {
  const harness = await renderRow({ capabilities: REMOTE_CAPABILITIES });

  assert.deepEqual(harness.gateStates.at(-1), false);
  assert.doesNotMatch(harness.container.textContent ?? '', /Default working directory/);
  assert.equal(buttonWithLabel(harness.container, 'Choose folder'), undefined);

  await unmount(harness);
});

test('a failed capability read leaves the control hidden rather than guessing', async () => {
  const harness = await renderRow({
    capabilities: new Error('project snapshot unavailable'),
  });

  assert.deepEqual(harness.gateStates, [false]);
  assert.equal(buttonWithLabel(harness.container, 'Choose folder'), undefined);

  await unmount(harness);
});

test('an unverified target cannot set the directory', async () => {
  const harness = await renderRow({
    capabilities: LOCAL_CAPABILITIES,
    targetVerified: false,
  });

  assert.deepEqual(harness.gateStates, [false]);
  assert.equal(buttonWithLabel(harness.container, 'Choose folder'), undefined);

  await unmount(harness);
});

test('choosing a folder patches the client-owned Project preferences', async () => {
  const harness = await renderRow({ capabilities: LOCAL_CAPABILITIES });

  await clickButton(harness, 'Choose folder');

  assert.deepEqual(harness.patches, [
    { projects: { defaultWorkingDirectory: CHOSEN_DIRECTORY } },
  ]);
  assert.equal(harness.pickerCalls(), 1);

  await unmount(harness);
});

test('a cancelled picker is not a request to clear the directory', async () => {
  const harness = await renderRow({
    capabilities: LOCAL_CAPABILITIES,
    chosenDirectory: undefined,
  });

  await clickButton(harness, 'Choose folder');

  assert.equal(harness.pickerCalls(), 1);
  assert.deepEqual(harness.patches, []);

  await unmount(harness);
});

test('clearing sends an undefined directory and never opens a picker', async () => {
  const harness = await renderRow({ capabilities: LOCAL_CAPABILITIES });

  await clickButton(harness, 'Clear');

  assert.deepEqual(harness.patches, [{ projects: { defaultWorkingDirectory: undefined } }]);
  assert.equal(harness.pickerCalls(), 0);

  await unmount(harness);
});

test('there is nothing to clear when no directory is configured', async () => {
  const harness = await renderRow({
    capabilities: LOCAL_CAPABILITIES,
    defaultWorkingDirectory: undefined,
  });

  assert.ok(buttonWithLabel(harness.container, 'Choose folder'));
  assert.equal(buttonWithLabel(harness.container, 'Clear'), undefined);
  assert.match(harness.container.textContent ?? '', /Not set/);

  await unmount(harness);
});

async function renderRow(options: {
  capabilities: DesktopProjectCapabilities | Error;
  defaultWorkingDirectory?: string;
  chosenDirectory?: string;
  targetVerified?: boolean;
}): Promise<RowHarness> {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    requestAnimationFrame: (callback: () => void) => setImmediate(callback),
    cancelAnimationFrame: (handle: NodeJS.Immediate) => clearImmediate(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const patches: UpdateAppSettingsInput[] = [];
  let pickerCalls = 0;
  const bridge = {
    projects: {
      getSnapshot: async () => {
        if (options.capabilities instanceof Error) throw options.capabilities;
        return { projects: [], capabilities: options.capabilities };
      },
    },
    settings: {
      chooseDefaultWorkingDirectory: async () => {
        pickerCalls += 1;
        return 'chosenDirectory' in options ? options.chosenDirectory : CHOSEN_DIRECTORY;
      },
    },
  };
  // The row only uses these two bridge namespaces; a full MakaBridge fixture
  // would couple this test to every unrelated channel.
  Object.assign(window, { maka: bridge });
  Object.assign(globalThis, { maka: bridge });

  const gateStates: boolean[] = [];
  const configured =
    'defaultWorkingDirectory' in options
      ? options.defaultWorkingDirectory
      : CONFIGURED_DIRECTORY;

  function Harness() {
    const canSetLocalDefault = useLocalDefaultCapability(
      TEST_RUNTIME_HOST,
      options.targetVerified ?? true,
    );
    gateStates.push(canSetLocalDefault);
    if (!canSetLocalDefault) return null;
    return createElement(DefaultWorkingDirectoryRow, {
      defaultWorkingDirectory: configured,
      onUpdate: async (patch: UpdateAppSettingsInput) => {
        patches.push(patch);
        return { settings: {} as never };
      },
    });
  }

  const container = document.querySelector('#root');
  assert.ok(container instanceof window.HTMLElement);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(ToastProvider, {
          children: createElement(Harness),
        }),
      }),
    );
  });
  // The capability read resolves a microtask after mount.
  await act(async () => undefined);
  return { container, root, patches, pickerCalls: () => pickerCalls, gateStates };
}

async function clickButton(harness: RowHarness, label: string): Promise<void> {
  const button = buttonWithLabel(harness.container, label);
  assert.ok(button, `expected a "${label}" button`);
  await act(async () => {
    button.click();
  });
  // The click awaits the picker and then the save.
  await act(async () => undefined);
}

async function unmount(harness: RowHarness): Promise<void> {
  await act(async () => {
    harness.root.unmount();
  });
}

function buttonWithLabel(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  const buttons = container.querySelectorAll('button');
  return [...buttons].find(
    (button) =>
      button.getAttribute('aria-label') === label || button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}
