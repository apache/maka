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

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

export const WINDOWS_SANDBOX_PHASE4_MATRIX = Object.freeze([
  {
    category: 'filesystem_aliases',
    evidence: ['junction admission', 'multi-hard-link admission', 'outside-root read denial'],
  },
  {
    category: 'network_channels',
    evidence: ['TCP connect denial'],
  },
  { category: 'ipc', evidence: ['host named-pipe denial', 'bounded inherited handle list'] },
  {
    category: 'descendants',
    evidence: [
      'descendant creation denied or AppContainer token retained',
      'kill-on-close Job membership',
    ],
  },
  {
    category: 'environment',
    evidence: ['ambient host secret omitted', 'closed allowlisted environment'],
  },
  {
    category: 'credentials',
    evidence: ['outside credential-file denial', 'ambient secret omission'],
  },
  { category: 'registry', evidence: ['host HKCU value denial'] },
  {
    category: 'lifecycle_failures',
    evidence: [
      'client cancellation',
      'Runtime Host parent death',
      '64-launch concurrency soak',
      'quarantined identity non-reuse',
    ],
  },
]);

export const WINDOWS_SANDBOX_DEFERRED_HARDENING = Object.freeze([
  'Authenticode identity verification',
  'direct Credential Manager and DPAPI probes',
  'inbound listener enforcement',
  'UDP channel enforcement',
  'no-Win32k mitigation',
  'dedicated window-station and clipboard isolation',
  'power-loss automatic recovery',
]);

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
      // The target is genuinely missing; 'missing' is the truthful T0 state
      // so the client lets the request through and the sandbox's own
      // fail-closed parent-entry check is what rejects it (#3487).
      await execute(
        { kind: 'write', path: join(workspace, 'missing.txt'), content: 'x' },
        'missing',
      );
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

    console.log('[verify-windows-sandbox] cancelling an active packaged AppContainer worker');
    await verifyPackagedClientCancellation({
      FilesystemWorkerClient,
      FilesystemWorkerClientError,
      SandboxManager,
      WindowsBrokerSandboxBackend,
      createWindowsBrokerManifestWriter,
      client,
      launchSpec: launchSpec.spec,
      sandboxExecutable,
      workspace,
      targetPath: insidePath,
    });
    console.log('[verify-windows-sandbox] packaged client cancellation and recovery verified');

    console.log('[verify-windows-sandbox] killing a Runtime Host parent during launch');
    await verifyPackagedRuntimeHostParentDeath({
      appDirectory,
      appExecutable,
      sandboxExecutable,
      client,
      workspace,
      targetPath: insidePath,
    });
    console.log('[verify-windows-sandbox] Runtime Host parent-death cleanup verified');

    console.log('[verify-windows-sandbox] running the 64-launch packaged concurrency soak');
    await verifyPackagedConcurrencySoak({
      FilesystemWorkerClient,
      SandboxManager,
      WindowsBrokerSandboxBackend,
      createWindowsBrokerManifestWriter,
      launchSpec: launchSpec.spec,
      sandboxExecutable,
      workspace,
      targetPath: insidePath,
    });
    console.log('[verify-windows-sandbox] packaged concurrency soak verified');

    console.log('[verify-windows-sandbox] running the packaged adversarial matrix');
    await verifyPackagedAdversarialMatrix(sandboxExecutable);
    console.log('[verify-windows-sandbox] packaged adversarial matrix verified');

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
      // Same contract as above: a truthful T0 state so the client's own
      // permission gate (not the identity validation) is what denies.
      await execute(
        { kind: 'write', path: join(outside, 'blocked.txt'), content: 'blocked' },
        'missing',
      );
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

async function verifyPackagedRuntimeHostParentDeath({
  appDirectory,
  appExecutable,
  sandboxExecutable,
  client,
  workspace,
  targetPath,
}) {
  const requestId = `runtime-host-parent-death-${process.pid}-${randomBytes(4).toString('hex')}`;
  const launchRequestId = `${requestId}-launch`;
  assertCondition(
    (await listCancellationProcesses(sandboxExecutable)).length === 0,
    'Runtime Host parent-death evidence started with an existing sandbox process.',
  );

  const child = spawn(
    appExecutable,
    [
      fileURLToPath(import.meta.url),
      '--runtime-host-mid-launch-child',
      JSON.stringify({ appDirectory, workspace, targetPath, requestId }),
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });

  let primaryError;
  try {
    await waitForObservation({
      description: 'Runtime Host-owned packaged AppContainer child',
      probe: (remainingMs) => listCancellationProcesses(sandboxExecutable, remainingMs),
      accept: (processes) => processes.length >= 2,
      settledEarly: () => child.exitCode !== null,
    });
    assertCondition(child.kill(), 'Could not terminate the Runtime Host fixture process.');
    await raceWithTimeout(
      exited,
      10_000,
      `Runtime Host fixture did not exit. stdout=${stdout} stderr=${stderr}`,
    );
    await waitForObservation({
      description: 'Runtime Host parent-death AppContainer tree exit',
      probe: (remainingMs) => listCancellationProcesses(sandboxExecutable, remainingMs),
      accept: (processes) => processes.length === 0,
    });
    await client.execute({
      operation: { kind: 'read', path: targetPath },
      cwd: workspace,
      mode: 'ask',
    });
    assertCondition(
      (await findRecoveryRecord(launchRequestId)) === undefined,
      'Runtime Host parent death left an ACL recovery ledger after a successful recovery launch.',
    );
  } catch (error) {
    primaryError = error;
  } finally {
    if (child.exitCode === null) child.kill();
    await raceWithTimeout(exited, 10_000, 'Runtime Host fixture cleanup timed out.').catch(
      () => undefined,
    );
  }
  if (primaryError) throw primaryError;
}

async function runRuntimeHostMidLaunchChild({ appDirectory, workspace, targetPath, requestId }) {
  const resourcesPath = join(appDirectory, 'resources');
  const appExecutable = join(appDirectory, 'Maka.exe');
  const sandboxExecutable = join(resourcesPath, 'windows-sandbox', 'maka-windows-sandbox.exe');
  const runtimeDist = join(repoRoot, 'packages', 'runtime', 'dist');
  const importDist = (relativePath) => import(pathToFileURL(join(runtimeDist, relativePath)).href);
  const { FilesystemWorkerClient } = await importDist('filesystem-worker/client.js');
  const { createFilesystemWorkerLaunchSpecProvider } = await importDist(
    'filesystem-worker/launch-spec.js',
  );
  const { SandboxManager } = await importDist('sandbox/sandbox-manager.js');
  const { WindowsBrokerSandboxBackend, createWindowsBrokerManifestWriter } = await importDist(
    'sandbox/windows-sandbox.js',
  );
  const getPackagedLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
    runtime: 'electron',
    executable: appExecutable,
    resourceLocation: { kind: 'desktop-packaged', resourcesPath },
  });
  const packaged = await getPackagedLaunchSpec();
  assertCondition(packaged.ok, 'Runtime Host fixture could not resolve the packaged launch spec.');
  const client = new FilesystemWorkerClient({
    sandboxManager: new SandboxManager([
      new WindowsBrokerSandboxBackend({
        clientPath: sandboxExecutable,
        writeManifest: createWindowsBrokerManifestWriter(),
        requestId: () => requestId,
      }),
    ]),
    platform: 'win32',
    newId: () => `${requestId}-operation`,
    timeoutMs: 60_000,
    getLaunchSpec: async () => ({
      ok: true,
      spec: {
        ...packaged.spec,
        program: sandboxExecutable,
        args: ['--stdio-probe', '--sleep', '47'],
      },
    }),
  });
  process.stdout.write('runtime-host-mid-launch-ready\n');
  await client.execute({
    operation: { kind: 'read', path: targetPath },
    cwd: workspace,
    mode: 'ask',
  });
  throw new Error('Runtime Host mid-launch fixture unexpectedly completed.');
}

async function verifyPackagedConcurrencySoak({
  FilesystemWorkerClient,
  SandboxManager,
  WindowsBrokerSandboxBackend,
  createWindowsBrokerManifestWriter,
  launchSpec,
  sandboxExecutable,
  workspace,
  targetPath,
}) {
  const prefix = `phase4-soak-${process.pid}-${randomBytes(4).toString('hex')}`;
  let sequence = 0;
  const soakClient = new FilesystemWorkerClient({
    sandboxManager: new SandboxManager([
      new WindowsBrokerSandboxBackend({
        clientPath: sandboxExecutable,
        writeManifest: createWindowsBrokerManifestWriter(),
        requestId: () => `${prefix}-${sequence++}`,
      }),
    ]),
    platform: 'win32',
    getLaunchSpec: async () => ({ ok: true, spec: launchSpec }),
  });

  const waves = 8;
  const concurrency = 8;
  for (let wave = 0; wave < waves; wave += 1) {
    const results = await Promise.all(
      Array.from({ length: concurrency }, () =>
        soakClient.execute({
          operation: { kind: 'read', path: targetPath },
          cwd: workspace,
          mode: 'ask',
        }),
      ),
    );
    assertCondition(
      results.every((result) => result.kind === 'read'),
      `Packaged concurrency soak wave ${wave + 1} returned a non-read result.`,
    );
  }
  assertCondition(sequence === waves * concurrency, 'Concurrency soak did not run 64 launches.');
  await waitForObservation({
    description: 'packaged concurrency soak process drain',
    probe: (remainingMs) => listCancellationProcesses(sandboxExecutable, remainingMs),
    accept: (processes) => processes.length === 0,
  });
  assertCondition(
    (await findRecoveryRecordsByPrefix(prefix)).length === 0,
    'Packaged concurrency soak left ACL recovery records behind.',
  );
}

async function verifyPackagedAdversarialMatrix(sandboxExecutable) {
  const script = join(repoRoot, 'experiments', 'windows-sandbox', 'adversarial-matrix-smoke.ps1');
  const { stdout, stderr } = await execFileAsync(
    'pwsh.exe',
    ['-NoProfile', '-NonInteractive', '-File', script, '-LauncherPath', sandboxExecutable],
    {
      cwd: repoRoot,
      timeout: 180_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assertCondition(
    stdout.includes('Phase 4 adversarial matrix verified:'),
    `Packaged adversarial matrix returned no completion evidence. stdout=${stdout} stderr=${stderr}`,
  );
}

async function verifyPackagedClientCancellation({
  FilesystemWorkerClient,
  FilesystemWorkerClientError,
  SandboxManager,
  WindowsBrokerSandboxBackend,
  createWindowsBrokerManifestWriter,
  client,
  launchSpec,
  sandboxExecutable,
  workspace,
  targetPath,
}) {
  const requestId = `packaged-client-cancel-${process.pid}-${randomBytes(4).toString('hex')}`;
  const launchRequestId = `${requestId}-launch`;
  const sleepSeconds = 47;
  assertCondition(
    (await listCancellationProcesses(sandboxExecutable)).length === 0,
    'Client-cancel evidence started with an existing sandbox process.',
  );
  const controller = new AbortController();
  const cancelClient = new FilesystemWorkerClient({
    sandboxManager: new SandboxManager([
      new WindowsBrokerSandboxBackend({
        clientPath: sandboxExecutable,
        writeManifest: createWindowsBrokerManifestWriter(),
        requestId: () => requestId,
      }),
    ]),
    platform: 'win32',
    newId: () => `${requestId}-operation`,
    timeoutMs: 60_000,
    getLaunchSpec: async () => ({
      ok: true,
      spec: {
        ...launchSpec,
        program: sandboxExecutable,
        args: ['--stdio-probe', '--sleep', String(sleepSeconds)],
      },
    }),
  });

  let cancellationError;
  let cancellationSettled = false;
  const cancellation = cancelClient
    .execute({
      operation: { kind: 'read', path: targetPath },
      cwd: workspace,
      mode: 'ask',
      abortSignal: controller.signal,
    })
    .then(
      () => {
        cancellationSettled = true;
      },
      (error) => {
        cancellationError = error;
        cancellationSettled = true;
      },
    );

  let primaryError;
  try {
    await waitForObservation({
      description: 'packaged client-cancel AppContainer child',
      probe: (remainingMs) => listCancellationProcesses(sandboxExecutable, remainingMs),
      accept: (processes) => processes.length >= 2,
      settledEarly: () => cancellationSettled,
    });

    controller.abort();
    await cancellation;
    assertCondition(
      cancellationError instanceof FilesystemWorkerClientError &&
        cancellationError.reason === 'aborted' &&
        cancellationError.stage === 'launch' &&
        cancellationError.dispatched === true,
      `Client cancellation did not report an unknown dispatched outcome: ${renderError(
        cancellationError,
      )}`,
    );

    await waitForObservation({
      description: 'packaged client-cancel AppContainer child exit',
      probe: (remainingMs) => listCancellationProcesses(sandboxExecutable, remainingMs),
      accept: (processes) => processes.length === 0,
    });

    // The process runner terminates the one-shot broker. Its kill-on-close Job
    // tears down the AppContainer child. The next ordinary launch owns any
    // stale-ledger replay before it establishes its own grants; a future
    // graceful-cancel path is also valid if it already cleaned the ledger.
    await client.execute({
      operation: { kind: 'read', path: targetPath },
      cwd: workspace,
      mode: 'ask',
    });
    assertCondition(
      (await findRecoveryRecord(launchRequestId)) === undefined,
      'Normal packaged launch did not remove the client-cancel recovery ledger.',
    );
  } catch (error) {
    primaryError = error;
  } finally {
    controller.abort();
    await cancellation;
    if (primaryError) {
      try {
        await client.execute({
          operation: { kind: 'read', path: targetPath },
          cwd: workspace,
          mode: 'ask',
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'Client-cancel evidence failed and its recovery launch also failed.',
        );
      }
    }
  }
  if (primaryError) throw primaryError;
}

async function listCancellationProcesses(sandboxExecutable, timeoutMs = 10_000) {
  const script = String.raw`
$imageName = [IO.Path]::GetFileName($env:MAKA_CANCEL_SANDBOX)
$escapedImageName = $imageName.Replace("'", "''")
$matches = @(
  Get-CimInstance Win32_Process -Filter "Name='$escapedImageName'" | ForEach-Object {
    [PSCustomObject]@{
      processId = $_.ProcessId
      commandLine = [string]$_.CommandLine
    }
  }
)
@($matches) | ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: {
        ...process.env,
        MAKA_CANCEL_SANDBOX: sandboxExecutable,
      },
      timeout: Math.min(timeoutMs, 10_000),
      windowsHide: true,
    },
  );
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function findRecoveryRecord(requestId) {
  const ledgerRoot = join(tmpdir(), 'maka-sandbox-acl-ledgers');
  const entries = await readdir(ledgerRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(ledgerRoot, entry.name);
    const contents = await readFile(path, 'utf8').catch(() => undefined);
    if (contents?.includes(`"requestId":"${requestId}"`)) return path;
  }
  return undefined;
}

async function findRecoveryRecordsByPrefix(prefix) {
  const ledgerRoot = join(tmpdir(), 'maka-sandbox-acl-ledgers');
  const entries = await readdir(ledgerRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(ledgerRoot, entry.name);
    const contents = await readFile(path, 'utf8').catch(() => undefined);
    if (contents?.includes(`"requestId":"${prefix}`)) matches.push(path);
  }
  return matches;
}

async function raceWithTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForObservation({
  description,
  probe,
  accept,
  settledEarly = () => false,
  timeoutMs = 30_000,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastObservation;
  let lastError;
  while (Date.now() < deadline) {
    if (settledEarly()) {
      throw new Error(`${description} settled before the expected state was observed.`);
    }
    try {
      lastObservation = await probe(Math.max(1, deadline - Date.now()));
      lastError = undefined;
      if (accept(lastObservation)) return lastObservation;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    `${description} was not observed within ${timeoutMs}ms.` +
      `${lastObservation === undefined ? '' : ` Last observation: ${JSON.stringify(lastObservation)}.`}` +
      `${lastError ? ` Last probe error: ${renderError(lastError)}.` : ''}`,
  );
}

function renderError(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return JSON.stringify(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--runtime-host-mid-launch-child') {
    const input = JSON.parse(process.argv[3] ?? 'null');
    assertCondition(input && typeof input === 'object', 'Missing Runtime Host fixture input.');
    await runRuntimeHostMidLaunchChild(input);
    process.exitCode = 1;
  } else {
    const appDirectory = process.argv[2];
    if (!appDirectory || basename(appDirectory).endsWith('.exe')) {
      throw new Error(
        'Usage: node scripts/verify-windows-sandbox-e2e.mjs <win-unpacked app directory>',
      );
    }
    await verifyWindowsSandboxWorkerE2E(appDirectory);
    console.log('Packaged Windows filesystem-worker E2E verified.');
  }
}
