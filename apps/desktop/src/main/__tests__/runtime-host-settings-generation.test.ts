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
import { act, createElement, Fragment, useEffect } from 'react';
import { teardownPendingAuthorization } from '../../renderer/settings/oauth-login-flow-guard.js';
import {
  RuntimeHostSettingsGenerationBoundary,
  RuntimeHostSettingsTarget,
} from '../../renderer/settings/runtime-host-settings-target.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

test('retires only Host-owned controllers when a same-key Host enters a new generation', async () => {
  const { root } = installReactRenderer();
  const lifecycle: string[] = [];
  const cancelled: string[] = [];

  function StableSettingsState() {
    useEffect(() => {
      lifecycle.push('stable:mount');
      return () => {
        lifecycle.push('stable:unmount');
      };
    }, []);
    return null;
  }

  function HostOwnedOAuthController() {
    useEffect(() => {
      const pendingAuthorization = { current: 'authorization-from-current-generation' };
      lifecycle.push('oauth:mount');
      return () => {
        lifecycle.push('oauth:unmount');
        teardownPendingAuthorization(pendingAuthorization, (id) => cancelled.push(id));
      };
    }, []);
    return null;
  }

  function render(generation: string) {
    root.render(createElement(RuntimeHostSettingsTarget, {
      host: { profileId: 'local', hostId: 'same-host-id' },
      generation,
      children: createElement(Fragment, {
        children: [
          createElement(StableSettingsState, { key: 'stable' }),
          createElement(RuntimeHostSettingsGenerationBoundary, {
            key: 'host-owned',
            children: createElement(HostOwnedOAuthController),
          }),
        ],
      }),
    }));
  }

  await act(async () => render('epoch-1'));
  assert.deepEqual(lifecycle, ['stable:mount', 'oauth:mount']);

  await act(async () => render('epoch-1'));
  assert.deepEqual(lifecycle, ['stable:mount', 'oauth:mount'], 'the same generation remains mounted');

  await act(async () => render('epoch-2'));
  assert.deepEqual(lifecycle, [
    'stable:mount',
    'oauth:mount',
    'oauth:unmount',
    'oauth:mount',
  ]);
  assert.deepEqual(cancelled, ['authorization-from-current-generation']);
});

afterEach(() => {
  cleanupFakeDom();
});
