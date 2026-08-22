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

import { createHash } from 'node:crypto';
import { access, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const executableName = 'Maka.exe';
const amd64Machine = 0x8664;
const temporaryCleanupRetries = 20;
const temporaryCleanupRetryDelayMs = 250;
// conpty echoes the command and terminates lines with CRLF, so the probe keeps
// matching on a substring rather than the whole output.

function runCommandFromRepo(command, args, options = {}) {
  return runCommand(command, args, { cwd: repoRoot, ...options });
}

// The release workflow shows only this script's output, so each stage announces
// itself: an unfinished stage is the one that hung.
function step(message) {
  console.log(`[verify-windows] ${message}`);
}

function runPowerShell(run, script) {
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

// A single-quoted PowerShell string is literal — a double-quoted one would
// expand `$` in a path we did not choose.
export function powerShellLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

// electron-builder writes the Windows product version resource in the four-part
// form Windows wants (app-builder-lib `AppInfo.getVersionInWeirdWindowsForm`),
// so 0.1.5 ships as 0.1.5.0 and the release version is its first three parts.
// The fourth part is a build number, which is 0 unless one is configured.
export function assertWindowsProductVersion(productVersion, expectedVersion) {
  const [expected] = expectedVersion.split('-');
  const parts = productVersion.trim().split('.');
  if (parts.length !== 4 || parts.slice(0, 3).join('.') !== expected || !/^\d+$/.test(parts[3])) {
    throw new Error(
      `Expected app version ${expected}.<build>, found ${productVersion.trim() || '<none>'}.`,
    );
  }
}

// The Windows build is unsigned, so the only architecture evidence in the
// artifact is the PE header of the executable itself.
export async function readPeMachine(path) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await file.read(header, 0, 4, 0x3c);
    if (bytesRead !== 4) {
      throw new Error(`${path} is too small to be a PE image.`);
    }
    const peOffset = header.readUInt32LE(0);
    const signature = Buffer.alloc(6);
    const peRead = await file.read(signature, 0, 6, peOffset);
    if (peRead.bytesRead !== 6 || signature.toString('latin1', 0, 4) !== 'PE\0\0') {
      throw new Error(`${path} is not a PE image.`);
    }
    return signature.readUInt16LE(4);
  } finally {
    await file.close();
  }
}

export async function verifyPackagedWindowsApp(
  appDirectory,
  {
    run = runCommandFromRepo,
    requirePath = access,
    forbidPath = assertMissing,
    readMachine = readPeMachine,
    smokeRenderer = smokePackagedRenderer,
    workingDirectory = appDirectory,
    expectedVersion,
    artifactContract = 'current',
  } = {},
) {
  if (artifactContract !== 'current' && artifactContract !== 'legacy-baseline') {
    throw new Error(`Unknown packaged Windows artifact contract: ${artifactContract}`);
  }
  const requiresCurrentContract = artifactContract === 'current';
  const product = await readProductManifestIdentity();
  const resources = join(appDirectory, 'resources');
  const executable = join(appDirectory, executableName);
  const appAsar = join(resources, 'app.asar');
  const sandboxExecutable = join(resources, 'windows-sandbox', 'maka-windows-sandbox.exe');

  step('checking packaged resources');
  await requirePath(executable);
  await assertPackagedResources(resources, {
    requirePath,
    forbidPath,
    requireWindowsSandbox: requiresCurrentContract,
    requireDisclaimer: requiresCurrentContract,
    bundledGitContract: requiresCurrentContract ? 'forbidden' : 'legacy-required',
  });
  if (requiresCurrentContract) await assertPackagedDependencyClosure(resources);
  else await requirePath(join(resources, 'git', 'cmd', 'git.exe'));

  step('reading the executable architecture');
  const machine = await readMachine(executable);
  if (machine !== amd64Machine) {
    throw new Error(`${executableName} must be x64, found PE machine 0x${machine.toString(16)}.`);
  }

  if (requiresCurrentContract) {
    step('smoking the packaged Windows sandbox');
    const sandboxMachine = await readMachine(sandboxExecutable);
    if (sandboxMachine !== amd64Machine) {
      throw new Error(
        `maka-windows-sandbox.exe must be x64, found PE machine 0x${sandboxMachine.toString(16)}.`,
      );
    }
    const sandboxLaunch = {
      version: 1,
      requestId: 'packaged-sandbox-launch',
      executable: sandboxExecutable,
      arguments: ['--self-probe'],
      cwd: dirname(sandboxExecutable),
      readRoots: [],
      writeRoots: [],
      exactReadRoots: [],
      exactWriteRoots: [],
      network: 'restricted',
      environment: {},
    };
    const sandboxManifest = join(workingDirectory, 'packaged-sandbox-manifest.json');
    await writeFile(
      sandboxManifest,
      JSON.stringify({
        version: 1,
        requestId: 'packaged-sandbox',
        clientPid: 0,
        clientNonce: '0123456789abcdef0123456789abcdef',
        profileDigest: createHash('sha256').update(JSON.stringify(sandboxLaunch)).digest('hex'),
        launch: sandboxLaunch,
      }),
      'utf8',
    );
    const sandboxProbe = await run(sandboxExecutable, ['--broker-local', sandboxManifest]);
    // The broker relays the child's stdout as the worker response channel and
    // keeps its own boundary diagnostics on stderr, so the channel split itself
    // is part of what this probe verifies: the child's --self-probe JSON must
    // arrive on stdout and the broker's atomic-job diagnostic on stderr.
    if (
      !sandboxProbe.stdout.includes('"appContainer":true') ||
      !sandboxProbe.stdout.includes('"inJob":true')
    ) {
      throw new Error(
        `Packaged Windows sandbox child probe did not reach stdout: ${sandboxProbe.stdout}`,
      );
    }
    if (!sandboxProbe.stderr.includes('"atomicJob":true')) {
      throw new Error(
        `Packaged Windows sandbox broker diagnostic did not reach stderr: ${sandboxProbe.stderr}`,
      );
    }
    await assertMissing(sandboxManifest);

    step('relaying command stdio through the packaged sandbox');
    await run('pwsh', [
      '-NoProfile',
      '-File',
      join(repoRoot, 'experiments', 'windows-sandbox', 'stdio-relay-smoke.ps1'),
      '-LauncherPath',
      sandboxExecutable,
    ]);

    step('running real filesystem-worker operations through the packaged app');
    // The evidence executes the packaged artifacts themselves: the packaged
    // broker, the packaged Electron executable as the worker runtime and the
    // packaged worker bundle under resources — not the repository dist worker
    // on a copied node.exe.
    const { verifyWindowsSandboxWorkerE2E } = await import('./verify-windows-sandbox-e2e.mjs');
    await verifyWindowsSandboxWorkerE2E(appDirectory);
  }

  step('reading the product version resource');
  const { stdout } = await runPowerShell(
    run,
    `(Get-Item -LiteralPath ${powerShellLiteral(executable)}).VersionInfo.ProductVersion`,
  );
  assertWindowsProductVersion(stdout, expectedVersion ?? product.version);

  step('smoking node-pty through conpty');
  const ptyProbe = makePtyProbe(
    process.env.ComSpec || 'cmd.exe',
    ['/c', 'echo', 'maka-node-pty-ok'],
    requiresCurrentContract ? product.runtimeHostSetupPackage : undefined,
  );
  await run(executable, ['-e', ptyProbe, join(appAsar, 'package.json')], {
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ...isolatedUserEnv(join(workingDirectory, 'pty-home')),
    },
    timeoutMs: 60_000,
  });

  step('smoking the packaged renderer');
  await smokeRenderer(executable, { workingDirectory });

  step('packaged app verified');
}

// Neither release artifact is inspected as an artifact: the NSIS installer has
// no readable app structure, and the ZIP is an archive of the win-unpacked
// directory electron-builder just produced. That directory is the app, so it is
// what gets verified — unpacking the ZIP would only rebuild a copy of it. The
// artifacts themselves are pinned by checksum, and installing the .exe is a
// checklist step. (macOS mounts its DMG instead because notarizing and stapling
// rewrite the DMG after packaging, so only the final artifact can be trusted.)
export async function verifyWindowsX64Release(
  inputPath,
  { platform = process.platform, verifyApp = verifyPackagedWindowsApp, checksum = sha256File } = {},
) {
  if (platform !== 'win32') {
    throw new Error('Windows release verification requires Windows.');
  }
  if (!inputPath) {
    throw new Error('Usage: npm run verify:windows-x64 -- <path-to-exe>');
  }

  const exePath = resolve(inputPath);
  if (!exePath.endsWith('.exe')) {
    throw new Error(`Expected the NSIS installer .exe, found ${basename(exePath)}.`);
  }
  const zipPath = `${exePath.slice(0, -'.exe'.length)}.zip`;
  const unpackedDirectory = join(dirname(exePath), 'win-unpacked');
  await access(exePath);
  await access(zipPath);
  await access(unpackedDirectory);

  // The smokes write into their working directory, which therefore must not be
  // the release directory the artifacts live in.
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'maka-release-verify-'));

  try {
    await verifyApp(unpackedDirectory, { workingDirectory: temporaryDirectory });

    step('checksumming the release artifacts');
    const checksums = [];
    for (const path of [exePath, zipPath]) {
      const sha256 = await checksum(path);
      const checksumPath = `${path}.sha256`;
      await writeFile(checksumPath, `${sha256}  ${basename(path)}\n`, 'utf8');
      checksums.push({ path, checksumPath, sha256 });
    }
    return { exePath, zipPath, unpackedDirectory, checksums };
  } finally {
    // The Runtime Host intentionally outlives its last Desktop client for its
    // idle grace period. On Windows, SQLite keeps the temporary workspace files
    // locked until that Host exits. fs.rm retries only the transient filesystem
    // errors for recursive removal, so cleanup follows the actual lock lifetime
    // without changing the production continuity policy.
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: temporaryCleanupRetries,
      retryDelay: temporaryCleanupRetryDelayMs,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyWindowsX64Release(process.argv[2]);
  console.log(`Verified ${result.exePath}`);
  for (const { path, sha256 } of result.checksums) {
    console.log(`SHA-256 ${sha256}  ${basename(path)}`);
  }
}
