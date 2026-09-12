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
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ArtifactDescriptor } from '@maka/core/artifacts';
import { LocaleProvider } from '@maka/ui';
import { ArtifactPreview } from '../../renderer/features/workbar/tools/artifacts/artifact-preview.js';
import {
  createFakeWorkbarServices,
  WorkbarServicesProvider,
} from '../../renderer/features/workbar/testing.js';

let mountedRoot: Root | undefined;
const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Node: globalThis.Node,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

test('HTML preview failure CTA uses the Finder reveal callback', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Node: window.Node,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  let revealCalls = 0;
  const services = createFakeWorkbarServices({
    artifacts: {
      ...createFakeWorkbarServices().artifacts,
      readText: async () => ({ ok: false, reason: 'read_failed' as const }),
    },
  });
  const record = {
    id: 'artifact-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    createdAt: 1,
    name: 'interactive.html',
    kind: 'html',
    sizeBytes: 42,
    mimeType: 'text/html',
    source: 'tool_result',
  } as ArtifactDescriptor;

  await act(async () => {
    root.render(createElement(
      LocaleProvider,
      {
        locale: 'en',
        children: createElement(
          WorkbarServicesProvider,
          { services },
          createElement(ArtifactPreview, {
            record,
            onShowInFolder: () => { revealCalls += 1; },
          }),
        ),
      },
    ));
    await Promise.resolve();
  });

  const button = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes('Show in Finder'),
  );
  assert.ok(button, 'failure card should expose a Finder action');
  await act(async () => {
    button.dispatchEvent(new window.Event('click', { bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(revealCalls, 1);
});
