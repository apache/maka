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
import { afterEach, test } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import type { StorageUsageQueryResult } from '@maka/runtime-host/protocol';
import {
  StorageUsageSection,
  StorageUsageServicesProvider,
  TaskStorageSize,
  type StorageUsageHostTarget,
} from '../../renderer/features/storage-usage/index.js';
import { RuntimeHostSettingsTarget } from '../../renderer/settings/runtime-host-settings-target.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  getComputedStyle: globalThis.getComputedStyle,
  IntersectionObserver: globalThis.IntersectionObserver,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

afterEach(() => {
  Object.assign(globalThis, originalGlobals);
});

test('the Storage section reads the selected Host once and states its caveats', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    getComputedStyle: (element: Element) =>
      ({ color: (element as HTMLElement).style?.color || 'currentColor' }) as CSSStyleDeclaration,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = { profileId: 'profile-1', hostId: 'host-1' };
  const requests: StorageUsageHostTarget[] = [];
  const usage: StorageUsageQueryResult = {
    measuredAt: 1,
    totals: [
      { kind: 'memory', bytes: 2048, exact: true },
      { kind: 'database', bytes: 3 * 1024 * 1024, exact: true },
      { kind: 'artifacts', bytes: 1024 * 1024, exact: false },
    ],
    reclaimableBytes: 512 * 1024,
    worktreeCount: 2,
  };
  const container = document.getElementById('root') as unknown as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, {
            children: createElement(StorageUsageServicesProvider, {
              services: {
                loadUsage: async (target) => {
                  requests.push(target);
                  return usage;
                },
                loadSessionUsage: async () => ({}),
              },
              children: createElement(RuntimeHostSettingsTarget, {
                host,
                children: createElement(StorageUsageSection, { hostVerified: true }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  const text = container.textContent ?? '';
  assert.deepEqual(requests, [host]);
  assert.match(text, /Total/);
  assert.match(text, /≈ 4\.0 MB/);
  // Rows follow the protocol's kind order, not the order the Host sent them in.
  assert.ok(text.indexOf('Task database') < text.indexOf('Artifacts'));
  assert.ok(text.indexOf('Artifacts') < text.indexOf('Long-term memory'));
  assert.match(text, /3\.0 MB/);
  assert.match(text, /≈ 1\.0 MB/);
  assert.match(text, /Usage history is kept after a task is deleted/);
  assert.match(text, /2 worktrees/);
  assert.match(text, /512\.0 KB/);
  // Only measured kinds are listed; nothing offers to delete or compact.
  assert.doesNotMatch(text, /Offloaded context/);
  assert.doesNotMatch(text, /Delete|Compact|Vacuum/);

  await act(async () => root.unmount());
});

test('a task row is measured only after it scrolls into view', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  const observers: Array<{
    readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void;
    disconnected: boolean;
  }> = [];
  class FakeIntersectionObserver {
    readonly #record: (typeof observers)[number];
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
      this.#record = { callback, disconnected: false };
      observers.push(this.#record);
    }
    observe() {}
    disconnect() {
      this.#record.disconnected = true;
    }
  }
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    getComputedStyle: (element: Element) =>
      ({ color: (element as HTMLElement).style?.color || 'currentColor' }) as CSSStyleDeclaration,
    IntersectionObserver: FakeIntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const requested: string[][] = [];
  const services = {
    loadUsage: async (): Promise<StorageUsageQueryResult> => {
      throw new Error('not used');
    },
    loadSessionUsage: async (sessionIds: readonly string[]) => {
      requested.push([...sessionIds]);
      return Object.fromEntries(
        sessionIds.map((sessionId) => [
          sessionId,
          {
            sessionId,
            bytes: { transcript: 1024, runtime: 1024, artifacts: 0 },
            worktreeCount: 0,
          },
        ]),
      );
    },
  };
  const container = document.getElementById('root') as unknown as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(StorageUsageServicesProvider, {
          services,
          children: [
            createElement(TaskStorageSize, { key: 'seen', sessionId: 'seen' }),
            createElement(TaskStorageSize, { key: 'unseen', sessionId: 'unseen' }),
          ],
        }),
      }),
    );
  });
  assert.equal(observers.length, 2);
  assert.deepEqual(requested, [], 'nothing is measured before a row is visible');

  await act(async () => {
    observers[0]!.callback([{ isIntersecting: true }]);
  });
  assert.deepEqual(requested, [['seen']]);
  assert.equal(observers[0]!.disconnected, true);
  assert.match(container.textContent ?? '', /Uses 2\.0 KB/);

  await act(async () => root.unmount());
});
