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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { PLUGIN_CLIENT_BUNDLE_CHUNK_MAX_BYTES } from '../protocol/plugin-platform.js';
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
