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
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';

import {
  createWindowsBrokerManifestWriter,
  WindowsBrokerSandboxBackend,
  type WindowsBrokerManifest,
} from '../sandbox/windows-sandbox.js';

test('writes broker manifests to exclusive per-process temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-windows-manifest-test-'));
  let manifestDirectory: string | undefined;
  try {
    const writeManifest = createWindowsBrokerManifestWriter(root);
    const manifest: WindowsBrokerManifest = {
      version: 1,
      requestId: 'request-1',
      clientPid: 0,
      clientNonce: 'a'.repeat(32),
      profileDigest: 'b'.repeat(64),
      launch: {
        version: 1,
        requestId: 'request-1-launch',
        executable: String.raw`C:\Windows\System32\cmd.exe`,
        arguments: [],
        cwd: String.raw`C:\work`,
        readRoots: [],
        writeRoots: [],
        exactReadRoots: [],
        exactWriteRoots: [],
        network: 'restricted',
        environment: {},
        timeoutMs: 130_000,
      },
    };
    const first = writeManifest(manifest);
    const second = writeManifest(manifest);
    manifestDirectory = dirname(first);
    assert.notEqual(first, second);
    assert.deepEqual(JSON.parse(await readFile(first, 'utf8')), manifest);
    assert.deepEqual(JSON.parse(await readFile(second, 'utf8')), manifest);
  } finally {
    if (manifestDirectory) await rm(manifestDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('transforms a Windows managed profile into a broker-client invocation', () => {
  let written: WindowsBrokerManifest | undefined;
  const backend = new WindowsBrokerSandboxBackend({
    clientPath: String.raw`C:\Program Files\Maka\maka-windows-sandbox.exe`,
    nonce: () => 'b'.repeat(32),
    requestId: () => 'request-1',
    writeManifest: (manifest) => {
      written = manifest;
      return String.raw`C:\Users\user\AppData\Local\Temp\request.json`;
    },
  });

  const result = backend.transform({
    platform: 'win32',
    command: {
      program: String.raw`C:\Windows\System32\cmd.exe`,
      args: ['/d', '/c', 'exit 0'],
      cwd: String.raw`C:\work\repo`,
      env: { SystemRoot: String.raw`C:\Windows` },
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: [String.raw`C:\work\repo`] },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.exec.argv, [
    String.raw`C:\Program Files\Maka\maka-windows-sandbox.exe`,
    '--broker-local',
    String.raw`C:\Users\user\AppData\Local\Temp\request.json`,
  ]);
  const launch = {
    version: 1 as const,
    requestId: 'request-1-launch',
    executable: String.raw`C:\Windows\System32\cmd.exe`,
    arguments: ['/d', '/c', 'exit 0'],
    cwd: String.raw`C:\work\repo`,
    readRoots: [String.raw`C:\work\repo`],
    writeRoots: [String.raw`C:\work\repo`],
    exactReadRoots: [],
    exactWriteRoots: [],
    network: 'restricted' as const,
    // Sorted like sortEnvironment emits it — the digest hashes this order.
    // The broker-injected marker tells the worker it is sandboxed, so Grep
    // fails closed there instead of approximating ripgrep.
    environment: { MAKA_WINDOWS_SANDBOX: '1', SystemRoot: String.raw`C:\Windows` },
    // Serialized last so pre-timeout manifests keep their historical digest.
    timeoutMs: 130_000,
  };
  assert.deepEqual(written, {
    version: 1,
    requestId: 'request-1',
    clientPid: 0,
    clientNonce: 'b'.repeat(32),
    profileDigest: createHash('sha256').update(JSON.stringify(launch)).digest('hex'),
    launch,
  });
  assert.equal(result.exec.sandboxType, 'windows');
});

test('rejects a request id with characters that are unsafe in a manifest filename', () => {
  // NTFS interprets ':' in a filename as an alternate-data-stream separator,
  // and the request id is embedded in the temporary manifest filename.
  const backend = new WindowsBrokerSandboxBackend({
    clientPath: String.raw`C:\Program Files\Maka\maka-windows-sandbox.exe`,
    requestId: () => 'request:1',
    writeManifest: () => String.raw`C:\Users\user\AppData\Local\Temp\request.json`,
  });
  const result = backend.transform({
    platform: 'win32',
    command: {
      program: String.raw`C:\Windows\System32\cmd.exe`,
      args: [],
      cwd: String.raw`C:\work\repo`,
      env: {},
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: [String.raw`C:\work\repo`] },
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'invalid_request');
    assert.match(result.message ?? '', /request id/i);
  }
});

test('rejects a request id whose derived launch id exceeds the native protocol bound', () => {
  const backend = new WindowsBrokerSandboxBackend({
    clientPath: String.raw`C:\Program Files\Maka\maka-windows-sandbox.exe`,
    requestId: () => 'a'.repeat(122),
    writeManifest: () => String.raw`C:\Users\user\AppData\Local\Temp\request.json`,
  });
  const result = backend.transform({
    platform: 'win32',
    command: {
      program: String.raw`C:\Windows\System32\cmd.exe`,
      args: [],
      cwd: String.raw`C:\work\repo`,
      env: {},
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: [String.raw`C:\work\repo`] },
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message ?? '', /request id/i);
});

test('honors a configured broker timeout and rejects out-of-range values', () => {
  let written: WindowsBrokerManifest | undefined;
  const backend = new WindowsBrokerSandboxBackend({
    clientPath: String.raw`C:\Program Files\Maka\maka-windows-sandbox.exe`,
    timeoutMs: 45_000,
    writeManifest: (manifest) => {
      written = manifest;
      return String.raw`C:\Users\user\AppData\Local\Temp\request.json`;
    },
  });
  const input = {
    platform: 'win32' as const,
    command: {
      program: String.raw`C:\Windows\System32\cmd.exe`,
      args: [],
      cwd: String.raw`C:\work\repo`,
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: [String.raw`C:\work\repo`] },
    },
  };
  assert.equal(backend.transform(input).ok, true);
  assert.equal(written?.launch.timeoutMs, 45_000);

  const outOfRange = new WindowsBrokerSandboxBackend({
    clientPath: String.raw`C:\Program Files\Maka\maka-windows-sandbox.exe`,
    timeoutMs: 999,
    writeManifest: () => String.raw`C:\Users\user\AppData\Local\Temp\request.json`,
  }).transform(input);
  assert.equal(outOfRange.ok, false);
  if (!outOfRange.ok) assert.equal(outOfRange.reason, 'invalid_request');
});

test('fails closed when broker client is unavailable or policy cannot be compiled', () => {
  const unavailable = new WindowsBrokerSandboxBackend({
    clientPath: 'client.exe',
    isAvailable: () => false,
    writeManifest: () => 'request.json',
  });
  const input = {
    platform: 'win32' as const,
    command: {
      program: String.raw`C:\Windows\System32\cmd.exe`,
      args: [],
      cwd: String.raw`C:\work\repo`,
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: [String.raw`C:\work\repo`] },
    },
  };
  const missing = unavailable.transform(input);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'backend_not_available');

  const invalid = new WindowsBrokerSandboxBackend({
    clientPath: 'client.exe',
    writeManifest: () => 'request.json',
  }).transform({
    ...input,
    command: { ...input.command, pathContext: { workspaceRoots: ['C:/work/repo'] } },
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.reason, 'invalid_request');
});
