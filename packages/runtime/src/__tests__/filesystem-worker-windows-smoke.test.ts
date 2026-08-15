import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';

import {
  FilesystemWorkerClient,
  FilesystemWorkerClientError,
} from '../filesystem-worker/client.js';
import { createFilesystemWorkerLaunchSpecProvider } from '../filesystem-worker/launch-spec.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import {
  createWindowsBrokerManifestWriter,
  WindowsBrokerSandboxBackend,
} from '../sandbox/windows-sandbox.js';

// Runs real Read/Write/Glob/Grep operations through FilesystemWorkerClient and
// the AppContainer broker, exercising the full stdio relay: request through
// broker stdin into the sandboxed worker, response back over stdout. Skipped
// off-Windows and when the debug broker has not been built
// (`cargo build --locked` in experiments/windows-sandbox/launcher).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const brokerPath = join(
  repoRoot,
  'experiments',
  'windows-sandbox',
  'launcher',
  'target',
  'debug',
  'maka-windows-sandbox.exe',
);
const enabled = process.platform === 'win32' && existsSync(brokerPath);

describe('Windows filesystem worker smoke', { skip: !enabled }, () => {
  let workspace: string;
  let outside: string;
  let client: FilesystemWorkerClient;

  let runtimeBase: string;

  before(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'maka-win-worker-smoke-')));
    // Outside the workspace AND outside tmpdir: the workspace-write profile
    // legitimately allows tmpdir writes, so a tmpdir sibling would not reject.
    outside = await realpath(await mkdtemp(join(homedir(), '.maka-win-worker-outside-')));
    // The launch spec grants the runtime root (parent of the executable's
    // directory) to the AppContainer recursively. Copy node.exe (self-contained
    // on Windows) into a shallow controlled tree so the grant covers exactly
    // this directory rather than whatever layout installed the host's node.
    runtimeBase = await realpath(await mkdtemp(join(tmpdir(), 'maka-win-worker-runtime-')));
    const runtimeBin = join(runtimeBase, 'runtime', 'bin');
    await mkdir(runtimeBin, { recursive: true });
    const nodeCopy = join(runtimeBin, 'node.exe');
    await copyFile(process.execPath, nodeCopy);
    client = new FilesystemWorkerClient({
      sandboxManager: new SandboxManager([
        new WindowsBrokerSandboxBackend({
          clientPath: brokerPath,
          writeManifest: createWindowsBrokerManifestWriter(),
        }),
      ]),
      platform: 'win32',
      getLaunchSpec: createFilesystemWorkerLaunchSpecProvider({
        runtime: 'node',
        executable: nodeCopy,
        resourceLocation: { kind: 'runtime' },
      }),
    });
  });

  after(async () => {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
      rm(runtimeBase, { recursive: true, force: true }),
    ]);
  });

  test('writes and reads back a workspace file through the sandboxed worker', async () => {
    const target = join(workspace, 'inside.txt');
    await client.execute({
      operation: { kind: 'write', path: target, content: 'windows-relay-ok' },
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(await readFile(target, 'utf8'), 'windows-relay-ok');

    const read = await client.execute({
      operation: { kind: 'read', path: target },
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(read.kind, 'read');
    if (read.kind === 'read') assert.match(read.content, /windows-relay-ok/);
  });

  test('runs glob and grep inside the operation-scoped sandbox', async () => {
    const sourceDirectory = join(workspace, 'src');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'health.ts'), 'export const healthSignal = true;\n');

    const globResult = await client.execute({
      operation: { kind: 'glob', path: sourceDirectory, pattern: '**/*.ts' },
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(globResult.kind, 'glob');
    if (globResult.kind === 'glob') {
      assert.equal(globResult.files.length, 1);
      assert.match(globResult.files[0] ?? '', /health\.ts$/);
    }

    const grepResult = await client.execute({
      operation: {
        kind: 'grep',
        path: sourceDirectory,
        pattern: 'healthSignal',
        maxCountPerFile: 50,
        limit: 200,
        timeoutMs: 10_000,
      },
      cwd: workspace,
      mode: 'ask',
    });
    assert.equal(grepResult.kind, 'grep');
    if (grepResult.kind === 'grep') {
      assert.equal(grepResult.matches.length, 1);
      assert.match(grepResult.matches[0] ?? '', /healthSignal/);
    }
  });

  test('fails closed for unapproved outside paths', async () => {
    await assert.rejects(
      client.execute({
        operation: {
          kind: 'write',
          path: join(outside, 'blocked.txt'),
          content: 'blocked',
        },
        cwd: workspace,
        mode: 'ask',
      }),
      (error: unknown) =>
        error instanceof FilesystemWorkerClientError && error.reason === 'path_denied',
    );
    assert.equal(existsSync(join(outside, 'blocked.txt')), false);
  });
});
