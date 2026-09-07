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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  configureDesktopRuntimeHostPeerClient,
  readDesktopRuntimeHostWebRtcStunPolicy,
  writeDesktopRuntimeHostWebRtcStunPolicy,
} from '../runtime-host-peer-client.js';

test('development uses the native peer addon only for the peer-enabled launch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-peer-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = join(root, 'apps', 'desktop');
  const nativePath = join(
    root,
    'native',
    'runtime-host-peer',
    'target',
    'release',
    'maka_runtime_host_peer.node',
  );
  const clientDataRoot = join(root, 'client');
  await mkdir(appPath, { recursive: true });
  await mkdir(dirname(nativePath), { recursive: true });
  await writeFile(nativePath, 'native addon');

  const ordinaryEnvironment: NodeJS.ProcessEnv = {};
  assert.equal(await configureDesktopRuntimeHostPeerClient({
    isPackaged: false,
    appPath,
    resourcesPath: join(root, 'resources'),
    clientDataRoot,
    environment: ordinaryEnvironment,
  }), undefined);
  assert.equal(ordinaryEnvironment.MAKA_RUNTIME_HOST_PEER_NATIVE_PATH, undefined);

  const peerEnvironment: NodeJS.ProcessEnv = {};
  assert.deepEqual(await configureDesktopRuntimeHostPeerClient({
    isPackaged: false,
    enableDevelopmentPeer: true,
    appPath,
    resourcesPath: join(root, 'resources'),
    clientDataRoot,
    environment: peerEnvironment,
  }), {
    nativePath,
    keyPath: join(clientDataRoot, 'runtime-host-client.peer.key'),
    automaticRelayDiscovery: true,
    webRtcStunUrls: ['stun:stun.cloudflare.com:3478'],
    webRtcStunPolicy: { kind: 'default' },
  });
  assert.equal(peerEnvironment.MAKA_RUNTIME_HOST_PEER_NATIVE_PATH, nativePath);
});

test('persists one closed Desktop STUN policy and rejects TURN endpoints', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-peer-connectivity-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await readDesktopRuntimeHostWebRtcStunPolicy(root), { kind: 'default' });
  await writeDesktopRuntimeHostWebRtcStunPolicy(root, {
    kind: 'custom',
    urls: [
      'stun:one.example:3478',
      'stun:one.example:3478',
      'stun:[2001:db8::1]:3478',
    ],
  });
  assert.deepEqual(await readDesktopRuntimeHostWebRtcStunPolicy(root), {
    kind: 'custom',
    urls: ['stun:one.example:3478', 'stun:[2001:db8::1]:3478'],
  });
  await assert.rejects(
    writeDesktopRuntimeHostWebRtcStunPolicy(root, {
      kind: 'custom',
      urls: ['turn:turn.example:3478'],
    }),
    /must use stun:host/u,
  );
  await assert.rejects(
    writeDesktopRuntimeHostWebRtcStunPolicy(root, {
      kind: 'custom',
      urls: ['stun:one.example:not-a-port'],
    }),
    /numeric port/u,
  );
});

test('repairs a malformed Desktop STUN policy through the normal writer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-peer-connectivity-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'runtime-host-peer-connectivity.json'), '{ malformed');

  await assert.rejects(readDesktopRuntimeHostWebRtcStunPolicy(root), SyntaxError);
  await writeDesktopRuntimeHostWebRtcStunPolicy(root, { kind: 'default' });
  assert.deepEqual(await readDesktopRuntimeHostWebRtcStunPolicy(root), { kind: 'default' });
});
