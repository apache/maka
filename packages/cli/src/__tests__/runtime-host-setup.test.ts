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
import { execFile as execFileCallback } from 'node:child_process';
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
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  decodeRuntimeHostSetupFrame,
  encodeRuntimeHostSetupFrame,
  RUNTIME_HOST_SETUP_FRAME_PREFIX,
} from '@maka/runtime-host/operator';
import {
  prepareRuntimeHostManagedPackageDeployment,
  resolveRuntimeHostManagedDeploymentRoot,
} from '../runtime-host-managed-deployment.js';
import { runRuntimeHostSetupCli } from '../runtime-host-setup-command.js';
import {
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceConfig,
  type RuntimeHostManagedServiceResult,
  type RuntimeHostServiceBackend,
} from '../runtime-host-service-manager.js';

const execFile = promisify(execFileCallback);

test('managed setup converges on one exact package and verified Client pairing', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-setup-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePackageRoot = await createReleasePackage(base, '0.2.0');
  const clientDataRoot = join(base, 'config', 'Maka');
  const stateRoot = join(clientDataRoot, 'workspaces', 'default');
  const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
  const deploymentPathOptions = {
    env: { XDG_DATA_HOME: join(base, 'data') },
    homeDir: join(base, 'home'),
    platform: 'linux' as const,
  };
  const deploymentRoot = resolveRuntimeHostManagedDeploymentRoot(serviceId, deploymentPathOptions);
  await mkdir(join(deploymentRoot, 'versions', '.0.2.0.interrupted.tmp'), { recursive: true });
  let config: RuntimeHostManagedServiceConfig | null = null;
  let installCount = 0;
  let pairCount = 0;
  let rejectVerification = false;
  const revokedCredentialIds: string[] = [];
  let installedCliPath = '';
  const outputs: string[] = [];
  const options = {
    json: true,
    clientDataRoot,
    defaultRootPath: stateRoot,
    sourcePackageRoot,
    version: '0.2.0',
    principalId: 'desktop.client-1',
    preset: 'desktop-client',
  } as const;
  const overrides = {
    createBackend: () => unusedBackend(),
    manageService: async (input: { readonly action: string; readonly cliPath: string }) => {
      if (input.action === 'status') return serviceResult('status', config, '0.2.0');
      installCount += 1;
      installedCliPath = input.cliPath;
      config = {
        schemaVersion: 1,
        rootPath: stateRoot,
        projectDirectoryRoots: [],
        websocket: { host: '127.0.0.1', port: 42_111, path: '/runtime-host' },
        launch: { nodePath: process.execPath, cliPath: input.cliPath },
      };
      return serviceResult('install', config, '0.2.0');
    },
    prepareDeployment: (input: Parameters<typeof prepareRuntimeHostManagedPackageDeployment>[0]) =>
      prepareRuntimeHostManagedPackageDeployment(input, deploymentPathOptions),
    replaceCredential: async () => {
      pairCount += 1;
      return {
        rootId: 'a'.repeat(64),
        credential: `secret-${pairCount}`,
        credentialId: `credential-${pairCount}`,
        principalKind: 'remote_owner' as const,
        principalId: 'desktop.client-1',
        operationGrants: ['host.status'] as const,
        canPublishClientCapabilities: true,
        canUseHostPaths: false,
      };
    },
    prepareCredential: async () => {
      pairCount += 1;
      return {
        rootId: 'a'.repeat(64),
        credential: `secret-${pairCount}`,
        credentialId: `credential-${pairCount}`,
        principalKind: 'remote_owner' as const,
        principalId: 'desktop.client-1',
        operationGrants: ['host.status'] as const,
        canPublishClientCapabilities: true,
        canUseHostPaths: false,
      };
    },
    verifyCredential: async (input: { readonly endpoint: string; readonly credential: string }) => {
      assert.equal(input.endpoint, 'ws://127.0.0.1:42111/runtime-host');
      assert.match(input.credential, /^secret-/u);
      if (rejectVerification) throw new Error('verification failed');
    },
    revokeCredential: async ({ credentialId }: { readonly credentialId: string }) => {
      revokedCredentialIds.push(credentialId);
      return { credentialId, revoked: true };
    },
    writeOutput: (value: string) => outputs.push(value),
  };

  assert.equal(await runRuntimeHostSetupCli(options, overrides), 0);
  assert.equal(await runRuntimeHostSetupCli(options, overrides), 0);
  rejectVerification = true;
  assert.equal(
    await runRuntimeHostSetupCli({ ...options, deferPairingCommit: true }, overrides),
    1,
  );
  assert.equal(installCount, 3);
  assert.equal(pairCount, 3);
  assert.deepEqual(revokedCredentialIds, ['credential-3']);
  const canonicalDeploymentRoot = await realpath(deploymentRoot);
  assert.ok(installedCliPath.startsWith(canonicalDeploymentRoot));
  assert.equal(
    outputs.some((output) => output.includes('secret-')),
    false,
  );
  const frames = outputs.map((output) => decodeRuntimeHostSetupFrame(output));
  assert.equal(frames.filter((frame) => frame?.kind === 'complete').length, 2);
  const complete = frames.find((frame) => frame?.kind === 'complete');
  assert.equal(complete?.kind === 'complete' ? complete.credential : undefined, 'secret-1');
  const operatorPath = complete?.kind === 'complete' ? complete.operatorPath : undefined;
  assert.equal(operatorPath, join(canonicalDeploymentRoot, 'operator'));
  const operator = await readFile(operatorPath!, 'utf8');
  assert.match(operator, /versions\/0\.2\.0\/dist\/cli\.js/u);
  assert.match(operator, /--client-data-root/u);
  assert.equal(operator.includes(clientDataRoot), true);

  assert.deepEqual(await readdir(join(canonicalDeploymentRoot, 'versions')), ['0.2.0']);
  assert.equal(
    JSON.parse(
      await readFile(join(canonicalDeploymentRoot, 'versions', '0.2.0', 'package.json'), 'utf8'),
    ).version,
    '0.2.0',
  );
});

test('managed setup frames reject malformed machine output', () => {
  assert.equal(
    decodeRuntimeHostSetupFrame(
      encodeRuntimeHostSetupFrame({
        schemaVersion: 1,
        sequence: 0,
        kind: 'progress',
        phase: 'checking_environment',
      }),
    )?.kind,
    'progress',
  );
  assert.equal(
    decodeRuntimeHostSetupFrame(
      `${RUNTIME_HOST_SETUP_FRAME_PREFIX}${Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          sequence: 0,
          kind: 'complete',
          version: '0.2.0',
          rootId: 'root',
          endpoint: 'ws://example.com/runtime-host',
          credentialId: 'credential',
          credential: 'secret',
        }),
      ).toString('base64url')}\n`,
    ),
    undefined,
  );
});

test('managed setup replaces one exact development package with another', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-setup-development-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const previousVersion = '0.2.0-dev-111111111111';
  const nextVersion = '0.2.0-dev-222222222222';
  const previousPackage = await createReleasePackage(base, previousVersion);
  const nextPackage = await createReleasePackage(base, nextVersion);
  const clientDataRoot = join(base, 'config', 'Maka');
  const stateRoot = join(clientDataRoot, 'workspaces', 'default');
  const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
  const deploymentPathOptions = {
    env: { XDG_DATA_HOME: join(base, 'data') },
    homeDir: join(base, 'home'),
    platform: 'linux' as const,
  };
  const previousDeployment = await prepareRuntimeHostManagedPackageDeployment(
    { serviceId, clientDataRoot, sourcePackageRoot: previousPackage, version: previousVersion },
    deploymentPathOptions,
  );
  const previousConfig: RuntimeHostManagedServiceConfig = {
    schemaVersion: 1,
    rootPath: stateRoot,
    projectDirectoryRoots: [],
    websocket: { host: '127.0.0.1', port: 42_111, path: '/runtime-host' },
    launch: { nodePath: process.execPath, cliPath: previousDeployment.cliPath },
  };
  let installedCliPath: string | undefined;

  const exitCode = await runRuntimeHostSetupCli(
    {
      json: true,
      clientDataRoot,
      defaultRootPath: stateRoot,
      sourcePackageRoot: nextPackage,
      version: nextVersion,
      principalId: 'desktop.client-1',
      preset: 'desktop-client',
    },
    {
      createBackend: () => unusedBackend(),
      manageService: async (input: { readonly action: string; readonly cliPath: string }) => {
        if (input.action === 'status') {
          return serviceResult('status', previousConfig, previousVersion);
        }
        installedCliPath = input.cliPath;
        return serviceResult(
          'install',
          {
            ...previousConfig,
            launch: { ...previousConfig.launch, cliPath: input.cliPath },
          },
          nextVersion,
        );
      },
      prepareDeployment: (input) =>
        prepareRuntimeHostManagedPackageDeployment(input, deploymentPathOptions),
      replaceCredential: async () => ({
        rootId: 'a'.repeat(64),
        credential: 'new-development-secret',
        credentialId: 'new-development-credential',
        principalKind: 'remote_owner',
        principalId: 'desktop.client-1',
        operationGrants: ['host.status'],
        canPublishClientCapabilities: true,
        canUseHostPaths: false,
      }),
      verifyCredential: async () => undefined,
      writeOutput: () => undefined,
    },
  );

  assert.equal(exitCode, 0);
  assert.match(installedCliPath ?? '', /0\.2\.0-dev-222222222222/u);
  assert.deepEqual(await readdir(join(previousDeployment.root, 'versions')), [nextVersion]);
});

test('managed setup removes a newly copied package when service installation fails', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-setup-failure-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePackageRoot = await createReleasePackage(base, '0.2.0');
  const clientDataRoot = join(base, 'config', 'Maka');
  const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
  const deploymentPathOptions = {
    env: { XDG_DATA_HOME: join(base, 'data') },
    homeDir: join(base, 'home'),
    platform: 'linux' as const,
  };
  const outputs: string[] = [];
  const exitCode = await runRuntimeHostSetupCli(
    {
      json: true,
      clientDataRoot,
      defaultRootPath: join(clientDataRoot, 'workspaces', 'default'),
      sourcePackageRoot,
      version: '0.2.0',
      principalId: 'desktop.client-1',
      preset: 'desktop-client',
    },
    {
      createBackend: () => unusedBackend(),
      manageService: async (input: { readonly action: string }) => {
        if (input.action === 'status') return serviceResult('status', null, null);
        throw new RuntimeHostServiceManagerError(
          'service_manager_operation_failed',
          `Injected service failure ${'x'.repeat(2_000)}`,
        );
      },
      prepareDeployment: (input) =>
        prepareRuntimeHostManagedPackageDeployment(input, deploymentPathOptions),
      writeOutput: (value) => outputs.push(value),
    },
  );
  assert.equal(exitCode, 1);
  const failure = decodeRuntimeHostSetupFrame(outputs.at(-1) ?? '');
  assert.equal(failure?.kind, 'error');
  assert.equal(
    failure?.kind === 'error' ? Buffer.byteLength(failure.error.message, 'utf8') : 0,
    1_024,
  );
  await assert.rejects(
    access(
      join(
        resolveRuntimeHostManagedDeploymentRoot(serviceId, deploymentPathOptions),
        'versions',
        '0.2.0',
      ),
    ),
  );
});

test('managed operator binds its Client Data Root and survives package cleanup interruption', {
  skip: process.platform === 'win32',
}, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-operator-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const version = '0.2.0';
  const sourcePackageRoot = await createReleasePackage(base, version);
  const clientDataRoot = join(base, 'config', 'Maka');
  const deployment = await prepareRuntimeHostManagedPackageDeployment(
    {
      serviceId: resolveRuntimeHostManagedServiceId(clientDataRoot),
      clientDataRoot,
      sourcePackageRoot,
      version,
    },
    {
      env: { XDG_DATA_HOME: join(base, 'data') },
      homeDir: join(base, 'home'),
      platform: 'linux',
    },
  );
  await deployment.commit();

  const invocationPath = join(base, 'operator-argv.json');
  await writeFile(
    deployment.cliPath,
    `require('node:fs').writeFileSync(process.env.MAKA_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)));\n`,
  );
  await execFile(deployment.operatorPath, ['status'], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(base, 'different-config'),
      MAKA_TEST_OUTPUT: invocationPath,
    },
  });
  assert.deepEqual(JSON.parse(await readFile(invocationPath, 'utf8')), [
    'runtime-host',
    'service',
    'status',
    '--client-data-root',
    clientDataRoot,
  ]);

  await rm(join(deployment.root, 'versions'), { recursive: true });
  await execFile(deployment.operatorPath, ['__cleanup-managed-deployment']);
  await assert.rejects(access(deployment.root));
});

async function createReleasePackage(base: string, version: string): Promise<string> {
  const root = join(base, `source-package-${version}`);
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'node_modules', '@maka', 'runtime-host'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'maka-agent', version }));
  await writeFile(join(root, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  await writeFile(
    join(root, 'node_modules', '@maka', 'runtime-host', 'package.json'),
    JSON.stringify({ name: '@maka/runtime-host', version: '0.1.0' }),
  );
  return root;
}

function serviceResult(
  action: RuntimeHostManagedServiceResult['action'],
  config: RuntimeHostManagedServiceConfig | null,
  installedVersion: string | null,
): RuntimeHostManagedServiceResult {
  return {
    schemaVersion: 1,
    action,
    service: {
      manager: 'systemd_user',
      installed: config !== null,
      enabled: config !== null,
      active: config !== null,
      state: config ? 'running' : 'not_installed',
      pid: config ? 42 : null,
      lastExitCode: null,
      installedVersion,
      config,
    },
  };
}

function unusedBackend(): RuntimeHostServiceBackend {
  return {
    preflightInstall: async () => undefined,
    install: async () => assert.fail('Backend is not expected'),
    status: async () => assert.fail('Backend is not expected'),
    start: async () => assert.fail('Backend is not expected'),
    stop: async () => assert.fail('Backend is not expected'),
    restart: async () => assert.fail('Backend is not expected'),
    logs: async () => assert.fail('Backend is not expected'),
    uninstall: async () => assert.fail('Backend is not expected'),
  };
}
