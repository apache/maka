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
import {
  createDesktopOverlaysServices,
  SETTINGS_SECTION_STORAGE_KEY,
  type DesktopOverlaysBridge,
  type DesktopOverlaysEnvironment,
} from '../../renderer/platform/desktop/create-overlays-services.js';

function recordingEnvironment() {
  const writes: Array<[string, string]> = [];
  let blurred = 0;
  const environment: DesktopOverlaysEnvironment & { activeElement: unknown } = {
    activeElement: { blur: () => { blurred += 1; } },
    storage: {
      setItem(key: string, value: string) {
        writes.push([key, value]);
      },
    },
    get document() {
      return { activeElement: this.activeElement as Element | null };
    },
  };
  return { environment, writes, blurred: () => blurred };
}

test('the Desktop adapter hands the search namespace through and owns the browser edges', async () => {
  const calls: string[] = [];
  const search = {
    recall: async (request: { terms: readonly string[] }, requestId?: string) => {
      calls.push(`recall:${request.terms.join(',')}:${requestId}`);
      return { passages: [], gaps: '', searchedEverySession: true };
    },
    cancelRecall: async (requestId: string) => { calls.push(`cancel:${requestId}`); },
  };
  const bridge = { search } as unknown as DesktopOverlaysBridge;
  const { environment, writes, blurred } = recordingEnvironment();

  const services = createDesktopOverlaysServices(bridge, environment);

  assert.equal(services.search, bridge.search);
  await services.search.recall({ terms: ['plan'] }, 'search-1');
  await services.search.cancelRecall('search-1');
  services.settingsSection.persist('models');
  services.focus.blurActiveElement();

  assert.deepEqual(calls, ['recall:plan:search-1', 'cancel:search-1']);
  assert.deepEqual(writes, [[SETTINGS_SECTION_STORAGE_KEY, 'models']]);
  assert.equal(SETTINGS_SECTION_STORAGE_KEY, 'maka-settings-section-v1');
  assert.equal(blurred(), 1);
  assert.deepEqual(Object.keys(services).sort(), ['focus', 'search', 'settingsSection']);
});

test('the adapter tolerates an unavailable store and a missing active element', () => {
  const bridge = {
    search: {
      recall: async () => ({ passages: [], gaps: '', searchedEverySession: true }),
      cancelRecall: async () => undefined,
    },
  } as unknown as DesktopOverlaysBridge;
  const services = createDesktopOverlaysServices(bridge, {
    storage: {
      setItem() {
        throw new Error('storage disabled');
      },
    },
    document: { activeElement: null },
  });

  assert.doesNotThrow(() => services.settingsSection.persist('general'));
  assert.doesNotThrow(() => services.focus.blurActiveElement());
});
