import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';

import {
  WindowsBrokerSandboxBackend,
  type WindowsBrokerManifest,
} from '../sandbox/windows-sandbox.js';

test('transforms a Windows managed profile into a broker-client invocation', () => {
  let written: WindowsBrokerManifest | undefined;
  const backend = new WindowsBrokerSandboxBackend({
    clientPath: String.raw`C:\Program Files\Maka\maka-windows-sandbox.exe`,
    pipeName: String.raw`\\.\pipe\maka-sandbox-session`,
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
    '--broker-client',
    String.raw`\\.\pipe\maka-sandbox-session`,
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
    network: 'restricted' as const,
    environment: { SystemRoot: String.raw`C:\Windows` },
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

test('fails closed when broker client is unavailable or policy cannot be compiled', () => {
  const unavailable = new WindowsBrokerSandboxBackend({
    clientPath: 'client.exe',
    pipeName: String.raw`\\.\pipe\maka-sandbox-session`,
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
    pipeName: String.raw`\\.\pipe\maka-sandbox-session`,
    writeManifest: () => 'request.json',
  }).transform({
    ...input,
    command: { ...input.command, pathContext: { workspaceRoots: ['C:/work/repo'] } },
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.reason, 'invalid_request');
});
