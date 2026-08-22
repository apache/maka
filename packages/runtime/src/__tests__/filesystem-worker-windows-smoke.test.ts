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
    // Use a realistic product-owned application directory with unrelated
    // sibling applications. The launch spec must grant only `Maka`, never the
    // shared `Programs` parent.
    runtimeBase = await realpath(await mkdtemp(join(tmpdir(), 'maka-win-worker-runtime-')));
    const runtimeBin = join(runtimeBase, 'Programs', 'Maka');
    await mkdir(runtimeBin, { recursive: true });
    await mkdir(join(runtimeBase, 'Programs', 'UnrelatedApp'), { recursive: true });
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

  test('updates and reads back a pre-existing workspace file through the sandboxed worker', async () => {
    // Exact writes stay exact in the preview: the target exists, so the
    // grant covers only this file object and never its parent directory.
    const target = join(workspace, 'inside.txt');
    await writeFile(target, 'seeded');
    // A write mutation on an existing target must carry the identity captured
    // at lock acquisition (#2600): lstat the file and supply { dev, ino },
    // exactly as the boundary executor does in production.
    const { stat } = await import('node:fs/promises');
    const meta = await stat(target, { bigint: true });
    await client.execute({
      operation: { kind: 'write', path: target, content: 'windows-relay-ok' },
      cwd: workspace,
      mode: 'ask',
      expectedIdentity: { dev: String(meta.dev), ino: String(meta.ino) },
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

  test('fails closed on a write whose shape needs parent-entry authority', async () => {
    // A missing target could only be enforced as recursive Modify on its
    // existing parent — broader than the approved operation, so the preview
    // refuses it before any process launches.
    const missing = join(workspace, 'not-created-yet.txt');
    await assert.rejects(
      client.execute({
        operation: { kind: 'write', path: missing, content: 'blocked' },
        cwd: workspace,
        mode: 'ask',
      }),
      (error: unknown) =>
        error instanceof FilesystemWorkerClientError &&
        error.reason === 'invalid_request' &&
        error.stage === 'transform' &&
        /parent-entry/.test(error.message),
    );
    assert.equal(existsSync(missing), false);
  });

  test('runs glob inside the operation-scoped sandbox and keeps grep fail-closed', async () => {
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

    // The sandbox preview does not expose Grep: no in-process substitute
    // preserves the advertised regex/ripgrep contract, so the worker fails
    // closed instead of returning contract-divergent matches.
    await assert.rejects(
      client.execute({
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
      }),
      (error: unknown) =>
        error instanceof FilesystemWorkerClientError && error.reason === 'grep_unavailable',
    );
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
