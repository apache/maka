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
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { PLUGIN_CLIENT_BUNDLE_CHUNK_MAX_BYTES } from '../protocol/plugin-platform.js';
import { Context } from '@maka/runtime/plugin-kernel';
import { MakaCompositionLoader } from '@maka/runtime/plugin-composition-loader';
import { PluginClientBridgeService } from '@maka/runtime/plugin-client-bridge-service';
import { HostPluginPlatformCoordinator } from '../server/plugin-platform-coordinator.js';
import { HostPluginPlatform } from '../server/plugin-platform.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('Client-only packages use the unified Store, generation, and desktop-ui composition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-client-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  const bundle = `window.__MakaModuleLoader__.load({id:"weather",factory:()=>({apply(){}})});${'x'.repeat(
    PLUGIN_CLIENT_BUNDLE_CHUNK_MAX_BYTES,
  )}`;
  await writeFile(
    join(source, 'maka.extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'weather',
      displayName: 'Weather',
      configuration: {
        properties: { unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } },
      },
      client: { entry: 'client.js' },
      composition: { patch: 'maka.composition.yml' },
    }),
  );
  await writeFile(join(source, 'client.js'), bundle);
  await writeFile(
    join(source, 'maka.composition.yml'),
    JSON.stringify([
      {
        type: 'insert',
        rootId: 'desktop-ui',
        entry: { id: 'weather-ui', packageId: 'weather', config: { unit: 'celsius' } },
      },
    ]),
  );

  const control = join(root, 'control');
  const platform = new HostPluginPlatform(control);
  let installedClientDigest = '';
  await platform.recover();
  try {
    const installed = await platform.installPackage(source);
    assert.equal(installed.convergence, 'converged');

    const snapshot = await platform.clientSnapshot();
    assert.equal(snapshot.entries.length, 1);
    assert.deepEqual(snapshot.entries[0]?.config, { unit: 'celsius' });
    assert.equal(snapshot.entries[0]?.extensionId, 'weather');
    assert.equal(snapshot.entries[0]?.totalBytes, Buffer.byteLength(bundle));
    installedClientDigest = snapshot.entries[0]!.clientDigest;

    const orphan = join(control, 'plugin-generations-v1', 'orphan');
    await mkdir(orphan);
    await platform.reconcile();
    assert.deepEqual(
      (await platform.clientSnapshot()).entries.map(
        ({ generation: _generation, ...entry }) => entry,
      ),
      snapshot.entries.map(({ generation: _generation, ...entry }) => entry),
    );
    await assert.rejects(() => access(orphan));

    const chunks: Buffer[] = [];
    let offset = 0;
    do {
      const page = await platform.readClientBundle({
        kind: 'bundle',
        extensionId: snapshot.entries[0]!.extensionId,
        contentDigest: snapshot.entries[0]!.contentDigest,
        clientDigest: snapshot.entries[0]!.clientDigest,
        offset,
      });
      chunks.push(Buffer.from(page.content, 'base64'));
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (true);
    assert.equal(Buffer.concat(chunks).toString('utf8'), bundle);
    assert.ok(chunks.length > 1);
  } finally {
    await platform.close();
  }

  const recovered = new HostPluginPlatform(control);
  await recovered.recover();
  try {
    const snapshot = await recovered.clientSnapshot();
    assert.equal(snapshot.entries[0]?.clientDigest, installedClientDigest);
    assert.equal(snapshot.entries[0]?.extensionId, 'weather');
  } finally {
    await recovered.close();
  }
});

test('desktop-ui rejects a Host-only package instead of running Host code as Client code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-host-only-ui-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(
    join(source, 'maka.extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'host-only',
      runtime: { entry: 'host.js' },
      composition: { patch: 'maka.composition.yml' },
    }),
  );
  await writeFile(
    join(source, 'host.js'),
    'export default {packageId:"host-only",host:{apply(){throw new Error("must not run")}}};',
  );
  await writeFile(
    join(source, 'maka.composition.yml'),
    JSON.stringify([
      {
        type: 'insert',
        rootId: 'desktop-ui',
        entry: { id: 'host-only-ui', packageId: 'host-only' },
      },
    ]),
  );

  const platform = new HostPluginPlatform(join(root, 'control'));
  await platform.recover();
  try {
    const receipt = await platform.installPackage(source);
    assert.equal(receipt.convergence, 'diverged');
    assert.match(receipt.failures[0]?.diagnostic ?? '', /no Client plugin/u);
    assert.deepEqual((await platform.clientSnapshot()).entries, []);
  } finally {
    await platform.close();
  }
});

test('Client Remote is generation-fenced and streams are connection-owned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-client-remote-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(
    join(source, 'maka.extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'bridge',
      runtime: { entry: 'host.js' },
      client: { entry: 'client.js' },
      composition: { patch: 'maka.composition.yml' },
    }),
  );
  await writeFile(
    join(source, 'host.js'),
    `export default {packageId:"bridge",host:{apply(ctx){
      ctx.clientBridge.rpc({name:"bridge.echo",invoke(input){return input;}});
      ctx.clientBridge.rpc({name:"bridge.hang",invoke(){return new Promise(()=>{});}});
      ctx.clientBridge.stream({name:"bridge.hangstream",open(){return new Promise(()=>{});}});
      ctx.clientBridge.stream({name:"bridge.count",open:async function*(){yield 1;yield 2;}});
    }}};`,
  );
  await writeFile(
    join(source, 'client.js'),
    'window.__MakaModuleLoader__.load({id:"bridge",factory:()=>({apply(){}})});',
  );
  await writeFile(
    join(source, 'maka.composition.yml'),
    JSON.stringify([
      { type: 'insert', rootId: 'profile', entry: { id: 'bridge-host', packageId: 'bridge' } },
      { type: 'insert', rootId: 'desktop-ui', entry: { id: 'bridge-ui', packageId: 'bridge' } },
    ]),
  );

  const pluginRoot = new Context();
  const clientBridge = new PluginClientBridgeService(pluginRoot);
  const platform = new HostPluginPlatform(join(root, 'control'), {
    composition: new MakaCompositionLoader({ root: pluginRoot }),
    clientBridge,
  });
  const coordinator = new HostPluginPlatformCoordinator(platform);
  await platform.recover();
  try {
    await platform.installPackage(source);
    const snapshot = await platform.clientSnapshot();
    const entry = snapshot.entries[0]!;
    const fence = {
      authorityEpoch: snapshot.authorityEpoch,
      revision: snapshot.revision,
      entryId: entry.entryId,
      extensionId: entry.extensionId,
      generation: entry.generation,
      contentDigest: entry.contentDigest,
      clientDigest: entry.clientDigest,
    };
    const context = {
      connectionId: 'renderer-a',
      hostEpoch: 'host',
      principal: 'owner',
      acquireResidency: () => ({ release() {} }),
    };
    assert.deepEqual(
      await coordinator.handlers['plugin.client.remote.call'](
        { ...fence, method: 'bridge.echo', input: { ok: true } },
        context,
      ),
      { ok: true, result: { value: { ok: true } } },
    );
    const stale = await coordinator.handlers['plugin.client.remote.call'](
      { ...fence, revision: `sha256-${'f'.repeat(64)}`, method: 'bridge.echo', input: null },
      context,
    );
    assert.equal(stale.ok ? undefined : stale.error.code, 'operation_conflict');

    const opened = await coordinator.handlers['plugin.client.remote.stream.open'](
      { ...fence, method: 'bridge.count', input: null },
      context,
    );
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const denied = await coordinator.handlers['plugin.client.remote.stream.next'](
      { streamId: opened.result.streamId },
      { ...context, connectionId: 'renderer-b' },
    );
    assert.equal(denied.ok ? undefined : denied.error.code, 'not_found');
    const foreignClose = await coordinator.handlers['plugin.client.remote.stream.close'](
      { streamId: opened.result.streamId },
      { ...context, connectionId: 'renderer-b' },
    );
    assert.equal(foreignClose.ok ? undefined : foreignClose.error.code, 'not_found');
    assert.deepEqual(
      await coordinator.handlers['plugin.client.remote.stream.next'](
        { streamId: opened.result.streamId },
        context,
      ),
      { ok: true, result: { done: false, value: 1 } },
    );
    await coordinator.handlers['plugin.client.remote.stream.next'](
      { streamId: opened.result.streamId },
      context,
    );
    assert.deepEqual(
      await coordinator.handlers['plugin.client.remote.stream.next'](
        { streamId: opened.result.streamId },
        context,
      ),
      { ok: true, result: { done: true } },
    );
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(
        await coordinator.handlers['plugin.client.remote.stream.close'](
          { streamId: opened.result.streamId },
          context,
        ),
        { ok: true, result: { streamId: opened.result.streamId } },
      );
    }
    coordinator.releaseConnection(context.connectionId);
    const call = platform.invokeClientRemote({ ...fence, method: 'bridge.hang', input: null });
    const stream = platform.openClientRemoteStream({
      ...fence,
      method: 'bridge.hangstream',
      input: null,
    });
    const stoppedCall = assert.rejects(call);
    const stoppedStream = assert.rejects(stream);
    await platform.read(() => platform.clientSnapshot());
    // Both pending handlers ignore AbortSignal. Neither may hold the platform lock or shutdown.
    await platform.close();
    await Promise.all([stoppedCall, stoppedStream]);
  } finally {
    await platform.close();
    await pluginRoot.fiber.dispose();
  }
});

test('concurrent Client stream opens reserve the per-connection limit before awaiting', async () => {
  const releases: Array<() => void> = [];
  const platform = {
    openClientRemoteStream: () =>
      new Promise((resolve) => {
        releases.push(() =>
          resolve({
            identity: {
              entryId: 'entry',
              scopeId: 'profile',
              extensionId: 'fixture',
              generation: 1,
            },
            next: async () => ({ done: true, value: undefined }),
            close: async () => {},
          }),
        );
      }),
  } as unknown as HostPluginPlatform;
  const coordinator = new HostPluginPlatformCoordinator(platform);
  const context = {
    connectionId: 'renderer-concurrent',
    hostEpoch: 'host',
    principal: 'owner',
    acquireResidency: () => ({ release() {} }),
  };
  const input = {
    authorityEpoch: 1,
    revision: `sha256-${'1'.repeat(64)}`,
    entryId: 'entry',
    extensionId: 'fixture',
    generation: 1,
    contentDigest: `sha256-${'2'.repeat(64)}`,
    clientDigest: `sha256-${'3'.repeat(64)}`,
    method: 'fixture.stream',
    input: null,
  };
  const opened = Array.from({ length: 40 }, () =>
    coordinator.handlers['plugin.client.remote.stream.open'](input, context),
  );
  assert.equal(releases.length, 32);
  for (const release of releases) release();
  const results = await Promise.all(opened);
  assert.equal(results.filter((result) => result.ok).length, 32);
  assert.equal(
    results.filter((result) => !result.ok && result.error.code === 'operation_conflict').length,
    8,
  );
  coordinator.releaseConnection(context.connectionId);
});
