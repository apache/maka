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
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  decodeRuntimeHostSetupFrame,
  encodeRuntimeHostSetupFrame,
  resolveRuntimeHostManagedDeploymentConfigPath,
  RUNTIME_HOST_SETUP_FRAME_PREFIX,
} from '@maka/runtime-host/operator';
import {
  resolveRootControlNamespace,
  resolveRootOwnershipNamespace,
} from '@maka/storage/root-authority';
import {
  prepareRuntimeHostManagedPackageDeployment,
  resolveRuntimeHostManagedDeploymentRoot,
} from '../runtime-host-managed-deployment.js';
import { runRuntimeHostSetupCli } from '../runtime-host-setup-command.js';
import {
  resolveRuntimeHostManagedServiceId,
  type RuntimeHostServiceBackend,
} from '../runtime-host-service-manager.js';

const execFile = promisify(execFileCallback);
const PACKAGE_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

test('on-demand setup installs one exact deployment without a service backend', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-on-demand-setup-'));
  const stateRoot = join(base, 'state');
  const clientDataRoot = join(base, 'client');
  const outputs: string[] = [];
  let rootId = '';
  let prepareCount = 0;
  t.after(async () => {
    await Promise.all([
      rm(base, { recursive: true, force: true }),
      rootId
        ? rm(dirname(resolveRuntimeHostManagedDeploymentConfigPath(rootId)), {
            recursive: true,
            force: true,
          })
        : Promise.resolve(),
      rootId
        ? rm(join(resolveRootControlNamespace(), rootId), {
            recursive: true,
            force: true,
          })
        : Promise.resolve(),
      rootId
        ? rm(join(resolveRootOwnershipNamespace(), `${rootId}.lock`), {
            force: true,
          })
        : Promise.resolve(),
    ]);
  });

  const options = {
    json: true,
    lifecycle: 'on_demand',
    clientDataRoot,
    defaultRootPath: stateRoot,
    sourcePackageRoot: base,
    version: '1.2.3',
    principalId: 'desktop:client-1',
    preset: 'desktop-client',
  } as const;
  const deployment = (serviceId: string) => ({
    version: '1.2.3',
    root: resolveRuntimeHostManagedDeploymentRoot(serviceId),
    cliPath: '/verified/package/dist/cli.js',
    operatorPath: '/opt/maka/operator',
    activate: async () => undefined,
    cleanup: async () => undefined,
    rollback: async () => undefined,
  });
  const overrides = {
    createBackend: () => assert.fail('on-demand setup must not create a service backend'),
    manageService: async () => assert.fail('on-demand setup must not manage a service'),
    resolveRegistryCandidate: async () => ({
      kind: 'npm_registry',
      version: '1.2.3',
      integrity: PACKAGE_INTEGRITY,
    }),
    withRegistryPackage: async (_candidate, use) => use('/verified/package'),
    prepareDeployment: async (input) => {
      prepareCount += 1;
      return deployment(input.serviceId);
    },
    activateManaged: async (input) => {
      rootId = input.rootId;
      return {
        schemaVersion: 1,
        kind: 'result',
        deploymentId: `${rootId.slice(0, 8)}-${rootId.slice(8, 12)}-4${rootId.slice(13, 16)}-8${rootId.slice(17, 20)}-${rootId.slice(20, 32)}`,
        configRevision: 1,
        rootId,
        hostEpoch: 'host-epoch',
        pid: 1234,
        protocolVersion: 1,
        endpoint: {
          host: '127.0.0.1',
          port: 43_210,
          websocketPath: '/runtime-host',
        },
      };
    },
    replaceCredential: async () => ({
      rootId,
      credential: 'secret-token',
      credentialId: 'credential-1',
      principalKind: 'remote_owner' as const,
      principalId: 'desktop:client-1',
      operationGrants: [] as const,
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    }),
    verifyCredential: async ({ endpoint, rootId: expectedRootId }) => {
      assert.equal(endpoint, 'ws://127.0.0.1:43210/runtime-host');
      assert.equal(expectedRootId, rootId);
    },
    writeOutput: (value) => outputs.push(value),
  } satisfies NonNullable<Parameters<typeof runRuntimeHostSetupCli>[1]>;
  assert.equal(await runRuntimeHostSetupCli(options, overrides), 0);
  assert.equal(prepareCount, 1);
  const complete = outputs
    .map(decodeRuntimeHostSetupFrame)
    .find((frame) => frame?.kind === 'complete');
  assert.equal(complete?.kind, 'complete');
  const persisted = JSON.parse(
    await readFile(resolveRuntimeHostManagedDeploymentConfigPath(rootId), 'utf8'),
  ) as {
    lifecycle: { mode: string };
    listeners: { websocket: { port: number } };
  };
  assert.equal(persisted.lifecycle.mode, 'on_demand');
  assert.equal(persisted.listeners.websocket.port, 0);

  const rejected: string[] = [];
  assert.equal(
    await runRuntimeHostSetupCli(
      { ...options, directPeer: { coordinationRelays: [] } },
      { ...overrides, writeOutput: (value) => rejected.push(value) },
    ),
    1,
  );
  const failure = rejected
    .map(decodeRuntimeHostSetupFrame)
    .find((frame) => frame?.kind === 'error');
  assert.equal(
    failure?.kind === 'error' ? failure.error.code : undefined,
    'unsupported_lifecycle_configuration',
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

test('registry package identity avoids local content and recovers an interrupted removal', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-registry-package-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const version = '0.2.0';
  const localPackage = await createReleasePackage(join(base, 'local'), version);
  const registryPackage = await createReleasePackage(join(base, 'registry'), version);
  await writeFile(join(localPackage, 'dist', 'cli.js'), 'local package\n');
  await writeFile(join(registryPackage, 'dist', 'cli.js'), 'registry package\n');
  const clientDataRoot = join(base, 'config', 'Maka');
  const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
  const pathOptions = {
    env: { XDG_DATA_HOME: join(base, 'data') },
    homeDir: join(base, 'home'),
    platform: 'linux' as const,
  };
  const local = await prepareRuntimeHostManagedPackageDeployment(
    { serviceId, clientDataRoot, sourcePackageRoot: localPackage, version },
    pathOptions,
  );
  const registry = await prepareRuntimeHostManagedPackageDeployment(
    {
      serviceId,
      clientDataRoot,
      sourcePackageRoot: registryPackage,
      version,
      packageIntegrity: PACKAGE_INTEGRITY,
    },
    pathOptions,
  );

  assert.notEqual(local.cliPath, registry.cliPath);
  assert.match(registry.cliPath, /\/versions\/registry-[a-f0-9]{64}\/dist\/cli\.js$/u);
  assert.equal(await readFile(registry.cliPath, 'utf8'), 'registry package\n');
  await registry.cleanup();
  assert.deepEqual(await readdir(dirname(dirname(dirname(registry.cliPath)))), [
    basename(dirname(dirname(registry.cliPath))),
  ]);

  const registryRoot = dirname(dirname(registry.cliPath));
  const versionsRoot = dirname(registryRoot);
  await rename(registryRoot, join(versionsRoot, `.${basename(registryRoot)}.interrupted.deleted`));
  const recovered = await prepareRuntimeHostManagedPackageDeployment(
    {
      serviceId,
      clientDataRoot,
      sourcePackageRoot: registryPackage,
      version,
      packageIntegrity: PACKAGE_INTEGRITY,
    },
    pathOptions,
  );
  assert.equal(await readFile(recovered.cliPath, 'utf8'), 'registry package\n');
  assert.deepEqual(await readdir(versionsRoot), [basename(registryRoot)]);
});

test('managed operator binds its Client Data Root and routes deployment cleanup', {
  skip: process.platform === 'win32',
}, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-operator-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const version = '0.2.0';
  const sourcePackageRoot = await createReleasePackage(base, version);
  const clientDataRoot = join(base, 'config', 'Maka');
  const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
  const deployment = await prepareRuntimeHostManagedPackageDeployment(
    {
      serviceId,
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
  await deployment.activate();
  await deployment.cleanup();

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
    '--managed-root-id',
    serviceId,
  ]);

  await execFile(
    deployment.operatorPath,
    ['access', 'list', '--root', '/runtime-root', '--framed'],
    {
      env: { ...process.env, MAKA_TEST_OUTPUT: invocationPath },
    },
  );
  assert.deepEqual(JSON.parse(await readFile(invocationPath, 'utf8')), [
    'runtime-host',
    'access',
    'list',
    '--root',
    '/runtime-root',
    '--framed',
  ]);

  await execFile(deployment.operatorPath, ['activate', '--framed', '--root-id', 'a'.repeat(64)], {
    env: { ...process.env, MAKA_TEST_OUTPUT: invocationPath },
  });
  assert.deepEqual(JSON.parse(await readFile(invocationPath, 'utf8')), [
    'runtime-host',
    'activate',
    '--framed',
    '--root-id',
    'a'.repeat(64),
  ]);

  await execFile(
    deployment.operatorPath,
    [
      '__cleanup-managed-deployment',
      '--expected-service-id',
      serviceId,
      '--expected-root-path',
      '/srv/maka',
      '--expected-root-id',
      'a'.repeat(64),
    ],
    {
      env: { ...process.env, MAKA_TEST_OUTPUT: invocationPath },
    },
  );
  assert.deepEqual(JSON.parse(await readFile(invocationPath, 'utf8')), [
    'runtime-host',
    'service',
    'cleanup-deployment',
    '--expected-service-id',
    serviceId,
    '--expected-root-path',
    '/srv/maka',
    '--expected-root-id',
    'a'.repeat(64),
    '--client-data-root',
    clientDataRoot,
    '--managed-root-id',
    serviceId,
  ]);
});

async function createReleasePackage(base: string, version: string): Promise<string> {
  const root = join(base, `source-package-${version}`);
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'node_modules', '@maka', 'runtime-host'), {
    recursive: true,
  });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'maka-agent', version }));
  await writeFile(join(root, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  await writeFile(
    join(root, 'node_modules', '@maka', 'runtime-host', 'package.json'),
    JSON.stringify({ name: '@maka/runtime-host', version: '0.1.0' }),
  );
  return root;
}

function unusedBackend(): RuntimeHostServiceBackend {
  return {
    preflightDeployment: async () => undefined,
    stageDeployment: async () => assert.fail('Backend is not expected'),
    replace: async () => assert.fail('Backend is not expected'),
    verifyReplacementPreconditions: async () => assert.fail('Backend is not expected'),
    verifyDeployment: async () => assert.fail('Backend is not expected'),
    status: async () => assert.fail('Backend is not expected'),
    start: async () => assert.fail('Backend is not expected'),
    stop: async () => assert.fail('Backend is not expected'),
    restart: async () => assert.fail('Backend is not expected'),
    retire: async () => assert.fail('Backend is not expected'),
    logs: async () => assert.fail('Backend is not expected'),
    uninstall: async () => assert.fail('Backend is not expected'),
  };
}
