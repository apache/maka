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
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
import type { ArtifactDescriptor } from '@maka/core/artifacts';
import { ArtifactPreview } from '../../renderer/features/workbar/tools/artifacts/artifact-preview.js';
import {
  createFakeWorkbarServices,
  WorkbarServicesProvider,
} from '../../renderer/features/workbar/testing.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = undefined;
  }
  Object.assign(globalThis, originalGlobals);
});

test('HTML read failure offers the existing safe open-path action', async () => {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Event: window.Event,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);

  const record: ArtifactDescriptor = {
    id: 'artifact-html',
    sessionId: 'session-html',
    turnId: 'turn-html',
    name: 'report.html',
    kind: 'html',
    mimeType: 'text/html',
    sizeBytes: 42,
    createdAt: 1,
    source: 'tool_result',
  };
  const calls: Array<[string, string]> = [];
  const defaults = createFakeWorkbarServices();
  const services = {
    ...defaults,
    artifacts: {
      ...defaults.artifacts,
      readText: async () => ({ ok: false as const, reason: 'read_failed' as const }),
      openPath: async (sessionId: string, artifactId: string) => {
        calls.push([sessionId, artifactId]);
        return { ok: true as const, opened: 'report.html' };
      },
    },
  };
  const root = createRoot(container);
  mountedRoot = root;

  await act(async () => {
    root.render(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(AstryxLocaleProvider, {
        children: createElement(WorkbarServicesProvider, {
          services,
          children: createElement(ArtifactPreview, {
            record,
            onShowInFolder: () => void services.artifacts.openPath(record.sessionId, record.id),
          }),
        }),
      }),
    }));
    await Promise.resolve();
  });

  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === 'Show in Finder',
  );
  assert.ok(button, 'HTML read failure should render a Finder fallback button');
  await act(async () => {
    button.dispatchEvent(new window.Event('click', { bubbles: true }));
    await Promise.resolve();
  });
  assert.deepEqual(calls, [['session-html', 'artifact-html']]);
});
