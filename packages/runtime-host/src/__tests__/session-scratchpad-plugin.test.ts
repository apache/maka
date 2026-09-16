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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PluginClientBridgeService } from '@maka/runtime/plugin-client-bridge-service';
import { MakaCompositionLoader } from '@maka/runtime/plugin-composition-loader';
import { PluginStorageService } from '@maka/runtime/plugin-data-services';
import { Context } from '@maka/runtime/plugin-kernel';
import { HostPluginDataRuntime } from '../server/plugin-data-runtime.js';
import { HostPluginPlatformCoordinator } from '../server/plugin-platform-coordinator.js';
import { HostPluginPlatform } from '../server/plugin-platform.js';

const pluginRoot = fileURLToPath(
  new URL('../../../../examples/plugins/session-scratchpad/', import.meta.url),
);

test('Session Scratchpad persists CAS notes and synchronizes them over a real Pull Stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-scratchpad-'));
  const context = new Context();
  const clientBridge = new PluginClientBridgeService(context);
  const storage = new PluginStorageService(context);
  storage.bindRuntime(new HostPluginDataRuntime(join(root, 'control')));
  const platform = new HostPluginPlatform(join(root, 'control'), {
    composition: new MakaCompositionLoader({ root: context }),
    clientBridge,
  });
  const coordinator = new HostPluginPlatformCoordinator(platform);
  const connection = {
    connectionId: 'scratchpad-renderer',
    hostEpoch: 'host',
    principal: 'owner',
    acquireResidency: () => ({ release() {} }),
  };

  try {
    await platform.recover();
    const receipt = await platform.installPackage(pluginRoot);
    assert.equal(receipt.convergence, 'converged');

    const snapshot = await platform.clientSnapshot();
    assert.equal(snapshot.entries.length, 1);
    const entry = snapshot.entries[0]!;
    const fence = {
      authorityEpoch: snapshot.authorityEpoch,
      revision: snapshot.revision,
      entryId: entry.entryId,
      extensionId: entry.extensionId,
      generation: entry.generation,
      contentDigest: entry.contentDigest,
      clientDigest: entry.clientDigest,
      sessionId: 'session-dogfood',
    };

    const opened = await coordinator.handlers['plugin.client.remote.stream.open'](
      { ...fence, method: 'session-scratchpad.watch', input: {} },
      connection,
    );
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.deepEqual(
      await coordinator.handlers['plugin.client.remote.stream.next'](
        { streamId: opened.result.streamId },
        connection,
      ),
      {
        ok: true,
        result: { done: false, value: { revision: 0, text: '', updatedAt: null } },
      },
    );

    const saved = await coordinator.handlers['plugin.client.remote.call'](
      {
        ...fence,
        method: 'session-scratchpad.save',
        input: { text: 'Remember the release checklist.', expectedRevision: 0 },
      },
      connection,
    );
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const savedValue = saved.result.value as {
      readonly revision: number;
      readonly text: string;
      readonly updatedAt: number;
    };
    assert.equal(savedValue.revision, 1);
    assert.equal(savedValue.text, 'Remember the release checklist.');
    assert.equal(typeof savedValue.updatedAt, 'number');

    const streamed = await coordinator.handlers['plugin.client.remote.stream.next'](
      { streamId: opened.result.streamId },
      connection,
    );
    assert.equal(streamed.ok, true);
    if (streamed.ok && !streamed.result.done) {
      assert.deepEqual(streamed.result.value, savedValue);
    }

    const read = await coordinator.handlers['plugin.client.remote.call'](
      { ...fence, method: 'session-scratchpad.get', input: {} },
      connection,
    );
    assert.deepEqual(read, saved);

    const invalid = await coordinator.handlers['plugin.client.remote.call'](
      {
        ...fence,
        method: 'session-scratchpad.save',
        input: { text: 'x'.repeat(12001), expectedRevision: 1 },
      },
      connection,
    );
    assert.equal(invalid.ok ? undefined : invalid.error.code, 'invalid_request');
  } finally {
    coordinator.releaseConnection(connection.connectionId);
    await platform.close();
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('Session Scratchpad Client bundle uses the public ABI and registers its two native Slots', async () => {
  const source = await readFile(join(pluginRoot, 'client.js'), 'utf8');
  let registration:
    | {
        readonly id: string;
        readonly factory: (require: (specifier: string) => unknown) => {
          readonly apply: (context: unknown, config: Readonly<Record<string, number>>) => void;
        };
      }
    | undefined;
  const window = {
    __MakaModuleLoader__: {
      load(value: typeof registration) {
        registration = value;
      },
    },
  };
  new Function('window', source)(window);
  assert.equal(registration?.id, 'maka.session-scratchpad');
  assert.ok(registration);
  const slots: string[] = [];
  const styles: string[] = [];
  const plugin = registration.factory(() => ({}));
  plugin.apply(
    {
      style(value: string) {
        styles.push(value);
      },
      slots: {
        register(options: { readonly name: string }) {
          slots.push(options.name);
        },
      },
      remote: {},
      events: {},
    },
    { maxLength: 12000 },
  );
  assert.deepEqual(slots, ['conversation.header.actions', 'shell.overlay']);
  assert.equal(styles.length, 1);
  assert.match(styles[0]!, /maka-session-scratchpad-panel/u);
});
