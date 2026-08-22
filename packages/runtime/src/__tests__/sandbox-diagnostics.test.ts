import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MacosSeatbeltBackend } from '../sandbox/macos-seatbelt.js';
import { LinuxBubblewrapBackend } from '../sandbox/linux-sandbox.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { WindowsBrokerSandboxBackend } from '../sandbox/windows-sandbox.js';
import {
  createSandboxDiagnosticsProvider,
  toSandboxRunTraceProjection,
} from '../sandbox/diagnostics.js';
import { SandboxCommandError, serializeSandboxError } from '../sandbox/errors.js';
import { renderSandboxTurnTailPrompt } from '../system-prompt/sandbox-context-prompt.js';
import { FilesystemWorkerClientError } from '../filesystem-worker/client.js';

describe('sandbox diagnostics', () => {
  test('keeps typed selection and filesystem-worker failure reasons', async () => {
    const unsupported = createSandboxDiagnosticsProvider({
      platform: 'win32',
      canonicalizePath: async (path) => path,
    });
    const unsupportedSnapshot = await unsupported.resolve({
      mode: 'execute',
      cwd: 'C:\\workspace',
    });
    assert.deepEqual(unsupportedSnapshot.capabilities.command.failure, {
      stage: 'selection',
      reason: 'backend_not_available',
    });
    assert.equal(unsupportedSnapshot.capabilities.command.backend, 'windows');

    const noWorker = createSandboxDiagnosticsProvider({
      platform: 'darwin',
      sandboxManager: new SandboxManager([new MacosSeatbeltBackend()]),
      isExecutable: async () => true,
      canonicalizePath: async (path) => path,
    });
    const noWorkerSnapshot = await noWorker.resolve({ mode: 'ask', cwd: '/workspace' });
    assert.deepEqual(noWorkerSnapshot.capabilities.filesystem, {
      status: 'unavailable',
      backend: 'macos-seatbelt',
      selectionReason: 'platform_sandbox_selected',
      failure: { stage: 'launch', reason: 'filesystem_worker_unavailable' },
    });
  });

  test('removes paths from durable trace projection but renders them in the turn tail', async () => {
    const provider = createSandboxDiagnosticsProvider({
      platform: 'darwin',
      sandboxManager: new SandboxManager([new MacosSeatbeltBackend()]),
      canonicalizePath: async (path) => path,
      isExecutable: async () => true,
    });
    const snapshot = await provider.resolve({ mode: 'ask', cwd: '/secret/workspace' });
    const projection = toSandboxRunTraceProjection(snapshot);

    assert.equal(JSON.stringify(projection).includes('/secret/workspace'), false);
    assert.match(renderSandboxTurnTailPrompt(snapshot), /Working directory: \/secret\/workspace/);
    assert.match(renderSandboxTurnTailPrompt(snapshot), /launch:filesystem_worker_unavailable/);
  });

  test('probes platform capabilities without materializing execution resources', async () => {
    let windowsManifestWrites = 0;
    const windows = createSandboxDiagnosticsProvider({
      platform: 'win32',
      sandboxManager: new SandboxManager([
        new WindowsBrokerSandboxBackend({
          clientPath: String.raw`C:\Program Files\Maka\maka-windows-sandbox.exe`,
          isAvailable: () => true,
          writeManifest: () => {
            windowsManifestWrites += 1;
            return String.raw`C:\Temp\sandbox-request.json`;
          },
        }),
      ]),
      getFilesystemWorkerLaunchSpec: async () => ({
        ok: true,
        spec: {
          program: String.raw`C:\Program Files\Maka\electron.exe`,
          args: [String.raw`C:\Program Files\Maka\filesystem-worker.js`],
          env: { SystemRoot: String.raw`C:\Windows` },
          runtimeReadableRoots: [String.raw`C:\Program Files\Maka`],
          executableRoots: [String.raw`C:\Program Files\Maka`],
        },
      }),
      isExecutable: async () => true,
      canonicalizePath: async (path) => path,
    });
    const windowsSnapshot = await windows.resolve({
      mode: 'ask',
      cwd: String.raw`C:\work\repo`,
      permissionProfile: {
        type: 'managed',
        name: 'workspace-write',
        fileSystem: {
          kind: 'restricted',
          entries: [{ kind: 'special', access: 'write', special: ':workspace_roots' }],
        },
        network: { kind: 'restricted' },
      },
    });
    assert.deepEqual(windowsSnapshot.capabilities.command, {
      status: 'unavailable',
      backend: 'windows',
      selectionReason: 'platform_sandbox_selected',
      failure: { stage: 'capability', reason: 'backend_not_implemented' },
    });
    assert.equal(windowsSnapshot.capabilities.filesystem.status, 'available');
    assert.equal(windowsManifestWrites, 0);

    let linuxWorkspaceScans = 0;
    const linux = createSandboxDiagnosticsProvider({
      platform: 'linux',
      sandboxManager: new SandboxManager([
        new LinuxBubblewrapBackend({
          capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
          discoverProtectedMetadataPaths: () => {
            linuxWorkspaceScans += 1;
            return [];
          },
        }),
      ]),
      getFilesystemWorkerLaunchSpec: async () => ({
        ok: true,
        spec: {
          program: '/usr/bin/node',
          args: ['/opt/maka/filesystem-worker.js'],
          env: {},
          runtimeReadableRoots: ['/opt/maka'],
          executableRoots: ['/usr/bin/node'],
        },
      }),
      isExecutable: async () => true,
      canonicalizePath: async (path) => path,
    });
    const linuxSnapshot = await linux.resolve({ mode: 'ask', cwd: '/workspace' });
    assert.equal(linuxSnapshot.capabilities.command.status, 'available');
    assert.equal(linuxSnapshot.capabilities.filesystem.status, 'available');
    assert.equal(linuxWorkspaceScans, 0);
  });
});

describe('sandbox error diagnostics', () => {
  test('serializes stable metadata without copying the raw error message', () => {
    const error = new SandboxCommandError({
      domain: 'command',
      stage: 'transform',
      reason: 'backend_not_available',
      backend: 'macos-seatbelt',
      recoverable: false,
      profileName: 'workspace-write',
      message: 'private path: /Users/example/secret',
    });

    const serialized = serializeSandboxError(error);
    assert.deepEqual(serialized, {
      domain: 'command',
      stage: 'transform',
      reason: 'backend_not_available',
      recoverable: false,
      backend: 'macos-seatbelt',
      profileName: 'workspace-write',
    });
    assert.equal(JSON.stringify(serialized).includes('/Users/example/secret'), false);
  });

  test('serializes filesystem worker validation failures through the same contract', () => {
    const serialized = serializeSandboxError(
      new FilesystemWorkerClientError({
        reason: 'path_denied',
        stage: 'validation',
        recoverable: false,
        requestId: 'request-1',
      }),
    );

    assert.deepEqual(serialized, {
      domain: 'filesystem',
      stage: 'validation',
      reason: 'path_denied',
      recoverable: false,
      requestId: 'request-1',
    });
  });

  test('preserves the exact expansion required for a session boundary request', () => {
    const serialized = serializeSandboxError(
      new FilesystemWorkerClientError({
        reason: 'sandbox_boundary_required',
        stage: 'validation',
        recoverable: true,
        requestId: 'request-2',
        requiredExpansion: {
          filesystem: {
            entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
          },
        },
      }),
    );

    assert.deepEqual(serialized, {
      domain: 'filesystem',
      stage: 'validation',
      reason: 'sandbox_boundary_required',
      recoverable: true,
      requestId: 'request-2',
      requiredExpansion: {
        filesystem: {
          entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
        },
      },
    });
  });

  test('rejects malformed required expansions instead of laundering them into diagnostics', () => {
    const serialized = serializeSandboxError({
      domain: 'filesystem',
      stage: 'validation',
      reason: 'sandbox_boundary_required',
      recoverable: true,
      requiredExpansion: {
        filesystem: {
          entries: [{ path: 'relative.txt', access: 'read', scope: 'exact' }],
        },
      },
    });

    assert.deepEqual(serialized, {
      domain: 'filesystem',
      stage: 'validation',
      reason: 'sandbox_boundary_required',
      recoverable: true,
    });
  });
});
