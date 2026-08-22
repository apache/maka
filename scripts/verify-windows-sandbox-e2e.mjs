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

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Runs real filesystem-worker operations (write, read, glob, a fail-closed
 * grep and a denied outside write) through FilesystemWorkerClient against the
 * PACKAGED Windows app: the packaged broker executable enforces the
 * AppContainer boundary, the packaged Electron executable is the worker
 * runtime (ELECTRON_RUN_AS_NODE, exactly as production launches it) and the
 * packaged `resources\workers\filesystem-worker.js` is the worker bundle.
 * Only the driver (client + launch-spec code) comes from the repository
 * build, because the packaged copy lives inside app.asar which plain node
 * cannot import; every executed artifact is the shipped one.
 */
export async function verifyWindowsSandboxWorkerE2E(appDirectoryPath) {
  const appDirectory = resolve(appDirectoryPath);
  const appExecutable = join(appDirectory, 'Maka.exe');
  const resourcesPath = join(appDirectory, 'resources');
  const sandboxExecutable = join(resourcesPath, 'windows-sandbox', 'maka-windows-sandbox.exe');
  const workerBundle = join(resourcesPath, 'workers', 'filesystem-worker.js');
  for (const [path, label] of [
    [appExecutable, 'packaged Electron executable'],
    [sandboxExecutable, 'packaged sandbox broker'],
    [workerBundle, 'packaged filesystem-worker bundle'],
  ]) {
    assertCondition(existsSync(path), `Missing ${label}: ${path}`);
  }
  const runtimeDist = join(repoRoot, 'packages', 'runtime', 'dist');
  const importDist = (relativePath) => import(pathToFileURL(join(runtimeDist, relativePath)).href);
  const { FilesystemWorkerClient, FilesystemWorkerClientError } = await importDist(
    'filesystem-worker/client.js',
  );
  const { createFilesystemWorkerLaunchSpecProvider } = await importDist(
    'filesystem-worker/launch-spec.js',
  );
  const { SandboxManager } = await importDist('sandbox/sandbox-manager.js');
  const { WindowsBrokerSandboxBackend, createWindowsBrokerManifestWriter } = await importDist(
    'sandbox/windows-sandbox.js',
  );

  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'maka-packaged-e2e-ws-')));
  const outside = await realpath(await mkdtemp(join(homedir(), '.maka-packaged-e2e-outside-')));
  try {
    const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
      runtime: 'electron',
      executable: appExecutable,
      resourceLocation: { kind: 'desktop-packaged', resourcesPath },
    });
    const launchSpec = await getLaunchSpec();
    assertCondition(launchSpec.ok, 'Windows filesystem-worker launch spec was unavailable.');
    assertCondition(
      launchSpec.ok && launchSpec.spec.program === (await realpath(appExecutable)),
      'Windows launch spec did not select the packaged Electron executable.',
    );
    assertCondition(
      launchSpec.ok && launchSpec.spec.args.includes(await realpath(workerBundle)),
      'Windows launch spec did not select the packaged worker bundle.',
    );
    // The recursive runtime grant must stay on the product-owned application
    // directory and never widen to the directory that contains it (for an
    // installed app that would be every sibling under `...\Programs`).
    const appRoot = await realpath(appDirectory);
    assertCondition(
      launchSpec.ok && launchSpec.spec.runtimeReadableRoots.includes(appRoot),
      'Windows launch spec omitted the packaged application directory.',
    );
    assertCondition(
      launchSpec.ok && !launchSpec.spec.runtimeReadableRoots.includes(dirname(appRoot)),
      'Windows launch spec widened the runtime ACL root past the application directory.',
    );

    const client = new FilesystemWorkerClient({
      sandboxManager: new SandboxManager([
        new WindowsBrokerSandboxBackend({
          clientPath: sandboxExecutable,
          writeManifest: createWindowsBrokerManifestWriter(),
        }),
      ]),
      platform: 'win32',
      getLaunchSpec,
    });
    const execute = (operation, expectedIdentity) =>
      client.execute({ operation, cwd: workspace, mode: 'ask', expectedIdentity });

    // Exact writes stay exact in the preview: the target is pre-seeded so the
    // grant covers only this file object, never its parent directory.
    const insidePath = join(workspace, 'inside.txt');
    await writeFile(insidePath, 'seeded');
    const insideMetadata = await stat(insidePath, { bigint: true });
    await execute(
      { kind: 'write', path: insidePath, content: 'packaged-relay-ok' },
      { dev: String(insideMetadata.dev), ino: String(insideMetadata.ino) },
    );
    assertCondition(
      (await readFile(insidePath, 'utf8')) === 'packaged-relay-ok',
      'Sandboxed write did not land in the workspace.',
    );

    // A missing target would need recursive Modify on its parent — broader
    // than the approved operation — so the preview fails it closed before
    // any launch.
    let parentEntryDenied = false;
    try {
      await execute({ kind: 'write', path: join(workspace, 'missing.txt'), content: 'x' });
    } catch (error) {
      parentEntryDenied =
        error instanceof FilesystemWorkerClientError &&
        error.reason === 'invalid_request' &&
        /parent-entry/.test(error.message);
    }
    assertCondition(parentEntryDenied, 'Missing-target write did not fail closed.');
    assertCondition(
      !existsSync(join(workspace, 'missing.txt')),
      'Failed-closed write still produced a file.',
    );

    const read = await execute({ kind: 'read', path: insidePath });
    assertCondition(
      read.kind === 'read' && read.content.includes('packaged-relay-ok'),
      'Sandboxed read did not return the written content.',
    );

    const sourceDirectory = join(workspace, 'src');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'health.ts'), 'export const healthSignal = true;\n');
    const globResult = await execute({
      kind: 'glob',
      path: sourceDirectory,
      pattern: '**/*.ts',
    });
    assertCondition(
      globResult.kind === 'glob' && globResult.files.length === 1,
      'Sandboxed glob did not find the expected file.',
    );
    // The sandbox preview does not expose Grep (no in-process substitute
    // preserves the ripgrep contract); the worker must fail closed.
    let grepUnavailable = false;
    try {
      await execute({
        kind: 'grep',
        path: sourceDirectory,
        pattern: 'healthSignal',
        maxCountPerFile: 50,
        limit: 200,
        timeoutMs: 10_000,
      });
    } catch (error) {
      grepUnavailable =
        error instanceof FilesystemWorkerClientError && error.reason === 'grep_unavailable';
    }
    assertCondition(grepUnavailable, 'Sandboxed grep did not fail closed as unavailable.');

    let denied = false;
    try {
      await execute({ kind: 'write', path: join(outside, 'blocked.txt'), content: 'blocked' });
    } catch (error) {
      denied = error instanceof FilesystemWorkerClientError && error.reason === 'path_denied';
    }
    assertCondition(denied, 'Write outside the workspace was not denied.');
    assertCondition(
      !existsSync(join(outside, 'blocked.txt')),
      'Denied write still produced a file.',
    );
  } finally {
    for (const path of [workspace, outside]) {
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appDirectory = process.argv[2];
  if (!appDirectory || basename(appDirectory).endsWith('.exe')) {
    throw new Error(
      'Usage: node scripts/verify-windows-sandbox-e2e.mjs <win-unpacked app directory>',
    );
  }
  await verifyWindowsSandboxWorkerE2E(appDirectory);
  console.log('Packaged Windows filesystem-worker E2E verified.');
}
