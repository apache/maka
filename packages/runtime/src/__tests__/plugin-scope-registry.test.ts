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
import { test } from 'node:test';
import { PluginScopeRegistry, type PluginScopeRegistryEntry } from '../plugin-scope-registry.js';

interface Entry extends PluginScopeRegistryEntry {
  readonly value: string;
}

function entry(value: string): Entry {
  return { value, token: Symbol(value), retired: false };
}

test('Session membership overlays Profile membership and retirement reveals the parent', async () => {
  const registry = new PluginScopeRegistry<Entry>();
  const disposeProfile = registry.publish('profile', 'policy', entry('profile'));
  const disposeSession = registry.publish('session:alpha', 'policy', entry('session'));

  assert.equal(registry.visible('alpha').get('policy')?.value, 'session');
  assert.equal(registry.visible('beta').get('policy')?.value, 'profile');

  await disposeSession();
  assert.equal(registry.visible('alpha').get('policy')?.value, 'profile');
  await disposeProfile();
  assert.deepEqual([...registry.visible('alpha')], []);
});

test('a committed replacement cannot resurrect its retired predecessor', async () => {
  const registry = new PluginScopeRegistry<Entry>();
  const previous = entry('previous');
  const replacement = entry('replacement');
  const disposePrevious = registry.publish('profile', 'policy', previous);
  const disposeReplacement = registry.publish('profile', 'policy', replacement);

  await disposePrevious();
  assert.equal(registry.visible('alpha').get('policy'), replacement);
  await disposeReplacement();
  assert.equal(registry.visible('alpha').has('policy'), false);
});

test('failed change notification rolls publication back atomically', () => {
  const registry = new PluginScopeRegistry<Entry>();
  const previous = entry('previous');
  registry.publish('profile', 'policy', previous);

  assert.throws(
    () =>
      registry.publish('profile', 'policy', entry('candidate'), {
        onChanged: () => {
          throw new Error('rejected');
        },
      }),
    /rejected/u,
  );
  assert.equal(registry.visible('alpha').get('policy'), previous);
});

test('retirement is idempotent and capability cleanup runs once', async () => {
  const registry = new PluginScopeRegistry<Entry>();
  let retired = 0;
  const dispose = registry.publish('profile', 'policy', entry('value'), {
    onRetired: () => {
      retired += 1;
    },
  });

  await dispose();
  await dispose();
  assert.equal(retired, 1);
});
