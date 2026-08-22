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

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILESYSTEM_WORKER_PROTOCOL_VERSION } from '../packages/runtime/dist/filesystem-worker/protocol.js';
import { readProductManifestIdentity } from './product-release-identity.mjs';
import {
  assertMissing,
  assertPackagedDependencyClosure,
  assertPackagedResources,
  isolatedUserEnv,
  makePtyProbe,
  runCommand,
  sha256File,
  smokePackagedRenderer,
} from './verify-packaged-app.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedAppId = 'com.maka.desktop';

function runCommandFromRepo(command, args, options = {}) {
  return runCommand(command, args, { cwd: repoRoot, ...options });
}

// macOS-only: the worker exists to enforce a sandbox profile, and Windows has no
// implementation of one, so the app there runs file tools in-process instead.
export async function smokePackagedFilesystemWorker(
  executable,
  worker,
  { workingDirectory, run = runCommand } = {},
) {
  const workspace = await realpath(workingDirectory);
  const target = join(workspace, 'filesystem-worker-smoke.txt');
  const content = 'maka-filesystem-worker-ok';
  const operationBoundary = {
    filesystem: {
      entries: [{ path: target, access: 'write', scope: 'exact' }],
    },
  };
  const request = {
    version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
    requestId: 'release-filesystem-worker-smoke',
    operation: { kind: 'write', cwd: workspace, path: target, content },
    operationBoundary,
    expectedTarget: {
      enforcementPath: target,
      access: 'write',
      scope: 'exact',
      targetType: 'missing',
    },
  };

  await rm(target, { force: true });
  try {
    const result = await run(executable, [worker], {
      cwd: workspace,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ...isolatedUserEnv(join(workspace, 'worker-home'), { temporaryDirectory: workspace }),
      },
      input: `${JSON.stringify(request)}\n`,
    });
    const response = JSON.parse(result.stdout);
    if (
      response?.ok !== true ||
      response.result?.kind !== 'write' ||
      (await readFile(target, 'utf8')) !== content
    ) {
      throw new Error(`Packaged filesystem worker smoke failed: ${result.stdout.trim()}`);
    }
  } finally {
    await rm(target, { force: true });
  }
}

function assertSingleArchitecture(output, subject) {
  const architectures = output.trim().split(/\s+/).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== 'arm64') {
    throw new Error(`${subject} must contain only arm64, found: ${architectures.join(', ')}`);
  }
}

async function readPlistValue(run, infoPlist, key) {
  const { stdout } = await run('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist]);
  return stdout.trim();
}

export async function verifyPackagedMacApp(
  appPath,
  {
    run = runCommandFromRepo,
    requirePath = access,
    forbidPath = assertMissing,
    smokeRenderer = smokePackagedRenderer,
    smokeFilesystemWorker = smokePackagedFilesystemWorker,
    workingDirectory = dirname(appPath),
  } = {},
) {
  const product = await readProductManifestIdentity();
  const contents = join(appPath, 'Contents');
  const resources = join(contents, 'Resources');
  const infoPlist = join(contents, 'Info.plist');

  const appId = await readPlistValue(run, infoPlist, 'CFBundleIdentifier');
  if (appId !== expectedAppId) {
    throw new Error(`Expected app id ${expectedAppId}, found ${appId}.`);
  }
  const version = await readPlistValue(run, infoPlist, 'CFBundleShortVersionString');
  if (version !== product.version) {
    throw new Error(`Expected app version ${product.version}, found ${version}.`);
  }
  const executableName = await readPlistValue(run, infoPlist, 'CFBundleExecutable');
  const executable = join(contents, 'MacOS', executableName);
  const filesystemWorker = join(resources, 'workers', 'filesystem-worker.js');
  const appAsar = join(resources, 'app.asar');

  await requirePath(executable);
  await assertPackagedResources(resources, { requirePath, forbidPath });
  await assertPackagedDependencyClosure(resources);

  const executableArchitectures = await run('lipo', ['-archs', executable]);
  assertSingleArchitecture(executableArchitectures.stdout, 'Maka executable');
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  await run('xcrun', ['stapler', 'validate', appPath]);

  const ptyProbe = makePtyProbe('/bin/echo', ['maka-node-pty-ok'], product.runtimeHostSetupPackage);
  await run(executable, ['-e', ptyProbe, join(appAsar, 'package.json')], {
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ...isolatedUserEnv(join(workingDirectory, 'pty-home')),
    },
  });
  await smokeFilesystemWorker(executable, filesystemWorker, { workingDirectory, run });
  await smokeRenderer(executable, { workingDirectory });
}

export async function verifyMacosArm64Dmg(
  inputPath,
  { platform = process.platform, run = runCommandFromRepo, verifyApp = verifyPackagedMacApp } = {},
) {
  if (platform !== 'darwin') {
    throw new Error('DMG verification requires macOS.');
  }
  if (!inputPath) {
    throw new Error('Usage: npm run verify:macos-arm64 -- <path-to-dmg>');
  }

  const dmgPath = resolve(inputPath);
  await access(dmgPath);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'maka-release-verify-'));
  const mountpoint = join(temporaryDirectory, 'mounted');
  const copiedApp = join(temporaryDirectory, 'Maka.app');
  await mkdir(mountpoint);
  let mounted = false;

  try {
    await run('hdiutil', ['attach', dmgPath, '-readonly', '-nobrowse', '-mountpoint', mountpoint]);
    mounted = true;
    const apps = (await readdir(mountpoint)).filter((name) => name.endsWith('.app'));
    if (apps.length !== 1) {
      throw new Error(`Expected one app in DMG, found ${apps.length}.`);
    }
    await run('ditto', [join(mountpoint, apps[0]), copiedApp]);
  } finally {
    if (mounted) {
      await run('hdiutil', ['detach', mountpoint]);
    }
  }

  try {
    await verifyApp(copiedApp, { workingDirectory: temporaryDirectory });
    const sha256 = await sha256File(dmgPath);
    const checksumPath = `${dmgPath}.sha256`;
    await writeFile(checksumPath, `${sha256}  ${basename(dmgPath)}\n`, 'utf8');
    return { dmgPath, checksumPath, sha256 };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyMacosArm64Dmg(process.argv[2]);
  console.log(`Verified ${result.dmgPath}`);
  console.log(`SHA-256 ${result.sha256}`);
}
