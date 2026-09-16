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
import { act, createElement, useEffect } from 'react';
import { useToast, useUiLocale } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  WorkHubServicesProvider,
  WorkHubSurfaceSwitch,
  type WorkHubServices,
} from '../../renderer/features/workhub/index.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

test('the main surface does not mount WorkHub or start its lifecycle', async () => {
  const { root, container } = installReactRenderer();
  const services = { surface: 'main' } as WorkHubServices;
  function UnexpectedWorkHub() {
    return assert.fail('WorkHub must not mount in the main surface');
  }
  try {
    await act(async () => root.render(createElement(WorkHubServicesProvider, {
      services,
      children: createElement(WorkHubSurfaceSwitch, {
        main: createElement('div', null, 'main'),
        workhub: createElement(UnexpectedWorkHub),
      }),
    })));
    assert.equal(container.textContent, 'main');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the WorkHub slot retains its providers and mount across locale updates', async () => {
  const { root } = installReactRenderer();
  let emitLocale!: (locale: UiLocale) => void;
  let latestLocale: UiLocale | undefined;
  let mounts = 0;
  let unmounts = 0;
  let subscriptions = 0;
  let unsubscribes = 0;
  let readyCalls = 0;
  const services = {
    surface: 'workhub',
    initialLocale: 'en',
    subscribeAppearance: (handler: (locale: UiLocale) => void) => {
      subscriptions += 1;
      emitLocale = handler;
      return () => { unsubscribes += 1; };
    },
    presentation: { ready: async () => { readyCalls += 1; } },
  } as WorkHubServices;
  function WorkHubProbe() {
    latestLocale = useUiLocale();
    assert.equal(typeof useToast().toast, 'function');
    useEffect(() => {
      mounts += 1;
      return () => { unmounts += 1; };
    }, []);
    return null;
  }
  function UnexpectedMain() {
    return assert.fail('the main shell must not mount in the WorkHub surface');
  }
  try {
    await act(async () => root.render(createElement(WorkHubServicesProvider, {
      services,
      children: createElement(WorkHubSurfaceSwitch, {
        main: createElement(UnexpectedMain),
        workhub: createElement(WorkHubProbe),
      }),
    })));
    assert.equal(latestLocale, 'en');
    await act(async () => emitLocale('zh-CN'));
    assert.equal(latestLocale, 'zh-CN');
    assert.deepEqual({ mounts, unmounts, subscriptions, readyCalls }, {
      mounts: 1, unmounts: 0, subscriptions: 1, readyCalls: 1,
    });
  } finally {
    await act(async () => root.unmount());
  }
  assert.equal(unmounts, 1);
  assert.equal(unsubscribes, 1);
});
