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
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  decodeRuntimeHostServiceManagementFrame,
  encodeRuntimeHostServiceManagementFrame,
  RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY,
  RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV,
  RUNTIME_HOST_OPERATOR_PEER_MANAGEMENT_CAPABILITY,
  RUNTIME_HOST_OPERATOR_PEER_RELAY_DISCOVERY_CAPABILITY,
  RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV,
  RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY,
  RUNTIME_HOST_SERVICE_LOG_MAX_BYTES,
  type RuntimeHostOperatorCapability,
  type RuntimeHostServiceManagementFrame,
} from '@maka/runtime-host/operator';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import { runtimeHostServiceLaunchArguments } from '../runtime-host-service-launch.js';
import {
  openRuntimeHostManagedPackageDeployment,
  prepareRuntimeHostManagedPackageDeployment,
  removeRuntimeHostManagedDeployment,
  resolveRuntimeHostManagedDeploymentRoot,
  resolveRuntimeHostManagedPackageCliPath,
} from '../runtime-host-managed-deployment.js';
import { runManagedRuntimeHostServiceCli } from '../runtime-host-service-management-command.js';
import { runManagedRuntimeHostUpdateCli } from '../runtime-host-update-command.js';
import {
  cleanupRuntimeHostManagedDeployment,
  effectiveRuntimeHostProjectDirectoryRoots,
  manageRuntimeHostService,
  replaceRuntimeHostManagedService,
  resolveRuntimeHostManagedServiceConfigPath,
  resolveRuntimeHostManagedServiceId,
  runtimeHostManagedServiceConfigFingerprint,
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceConfig,
  type RuntimeHostManagedServiceResult,
  type RuntimeHostServiceManagerOverrides,
  type RuntimeHostServiceBackend,
} from '../runtime-host-service-manager.js';
import {
  readRuntimeHostManagedUpdatePolicy,
  writeRuntimeHostManagedUpdatePolicy,
} from '../runtime-host-update-policy-store.js';
import {
  createSystemdUserRuntimeHostService,
  renderSystemdUnit,
  renderSystemdUpdateService,
  renderSystemdUpdateTimer,
  resolveSystemdUserRuntimeHostServicePath,
  resolveSystemdUserRuntimeHostUpdateServicePath,
  resolveSystemdUserRuntimeHostUpdateTimerPath,
} from '../runtime-host-systemd-service.js';

describe('managed Runtime Host service', () => {
  it('parses the bounded managed service command surface', () => {
    const nativeProjectRoot = process.platform === 'win32' ? 'C:\\projects' : '/srv/projects';
    assert.deepEqual(
      parseRuntimeHostCommand(['serve', '--project-root', `Native=${nativeProjectRoot}`]),
      {
        kind: 'runtime-host-serve',
        json: false,
        projectDirectoryRoots: [{ label: 'Native', path: nativeProjectRoot }],
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'install',
        '--root',
        '/srv/maka',
        '--project-root',
        'Home=/home/ada',
        '--websocket-port',
        '7443',
        '--json',
      ]),
      {
        kind: 'runtime-host-service-manage',
        action: 'install',
        json: true,
        rootPath: '/srv/maka',
        projectDirectoryRoots: [{ label: 'Home', path: '/home/ada' }],
        websocketPort: 7443,
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'install',
        '--project-root-json',
        JSON.stringify({ label: 'Home=Primary', path: '/home/ada' }),
      ]),
      {
        kind: 'runtime-host-service-manage',
        action: 'install',
        json: false,
        projectDirectoryRoots: [{ label: 'Home=Primary', path: '/home/ada' }],
      },
    );
    assert.equal(
      parseRuntimeHostCommand([
        'service',
        'configure',
        '--expected-config-fingerprint',
        `sha256:${'c'.repeat(64)}`,
        '--expected-service-id',
        'b'.repeat(64),
        '--expected-root-path',
        '/srv/maka',
        '--expected-root-id',
        'a'.repeat(64),
      ]).kind,
      'error',
    );
    assert.deepEqual(parseRuntimeHostCommand(['service', 'status', '--framed']), {
      kind: 'runtime-host-service-manage',
      action: 'status',
      json: false,
      framed: true,
    });
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'peer',
        'enable',
        '--framed',
        '--listen',
        '/ip4/0.0.0.0/udp/44001/quic-v1',
        '--clear-coordination-relays',
        '--no-automatic-relay-discovery',
        '--allow-interrupt-active-tasks',
        '--expected-service-id',
        'b'.repeat(64),
        '--expected-root-path',
        '/srv/maka',
        '--expected-root-id',
        'a'.repeat(64),
        '--managed-root-id',
        'a'.repeat(64),
        '--operator-deployment-id',
        '00000000-0000-4000-8000-000000000001',
      ]),
      {
        kind: 'runtime-host-service-peer',
        action: 'enable',
        json: false,
        framed: true,
        listenAddresses: ['/ip4/0.0.0.0/udp/44001/quic-v1'],
        coordinationRelays: [],
        automaticRelayDiscovery: false,
        allowInterruptActiveTasks: true,
        managedRootId: 'a'.repeat(64),
        operatorDeploymentId: '00000000-0000-4000-8000-000000000001',
        expectedTarget: {
          serviceId: 'b'.repeat(64),
          rootPath: '/srv/maka',
          rootId: 'a'.repeat(64),
        },
      },
    );
    assert.equal(parseRuntimeHostCommand(['service', 'peer', 'disable']).kind, 'error');
    for (const action of ['rotate', 'descriptor']) {
      assert.equal(
        parseRuntimeHostCommand([
          'service',
          'peer',
          action,
          '--framed',
          '--expected-service-id',
          'b'.repeat(64),
          '--expected-root-path',
          '/srv/maka',
          '--expected-root-id',
          'a'.repeat(64),
        ]).kind,
        'error',
      );
    }
    assert.equal(
      parseRuntimeHostCommand([
        'service',
        'peer',
        'enable',
        '--listen',
        '/ip4/0.0.0.0/udp/0/quic-v1',
        '--expected-service-id',
        'b'.repeat(64),
        '--expected-root-path',
        '/srv/maka',
        '--expected-root-id',
        'a'.repeat(64),
      ]).kind,
      'error',
    );
    assert.equal(
      parseRuntimeHostCommand([
        'service',
        'peer',
        'enable',
        '--listen',
        '/ip4/0.0.0.0/tcp/0',
        '--expected-service-id',
        'b'.repeat(64),
        '--expected-root-path',
        '/srv/maka',
        '--expected-root-id',
        'a'.repeat(64),
      ]).kind,
      'error',
    );
    assert.equal(
      parseRuntimeHostCommand([
        'service',
        'peer',
        'enable',
        '--clear-coordination-relays',
        '--coordination-relay',
        '/dns4/relay.example/tcp/443',
        '--expected-service-id',
        'b'.repeat(64),
        '--expected-root-path',
        '/srv/maka',
        '--expected-root-id',
        'a'.repeat(64),
      ]).kind,
      'error',
    );
    assert.equal(
      parseRuntimeHostCommand(['service', 'peer', 'status', '--root', '/srv/maka']).kind,
      'error',
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'status',
        '--framed',
        '--expected-service-id',
        'b'.repeat(64),
        '--expected-root-path',
        '/srv/maka',
        '--expected-root-id',
        'a'.repeat(64),
      ]),
      {
        kind: 'runtime-host-service-manage',
        action: 'status',
        json: false,
        framed: true,
        expectedTarget: {
          serviceId: 'b'.repeat(64),
          rootPath: '/srv/maka',
          rootId: 'a'.repeat(64),
        },
      },
    );
    assert.equal(parseRuntimeHostCommand(['service', 'uninstall', '--json']).kind, 'error');
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'uninstall',
        '--framed',
        '--retain-managed-deployment',
        '--allow-interrupt-active-tasks',
        '--expected-service-id',
        'b'.repeat(64),
        '--expected-root-path',
        '/srv/maka',
        '--expected-root-id',
        'a'.repeat(64),
      ]),
      {
        kind: 'runtime-host-service-manage',
        action: 'uninstall',
        json: false,
        framed: true,
        retainManagedDeployment: true,
        allowInterruptActiveTasks: true,
        expectedTarget: {
          serviceId: 'b'.repeat(64),
          rootPath: '/srv/maka',
          rootId: 'a'.repeat(64),
        },
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'retire',
        '--framed',
        '--allow-interrupt-active-tasks',
        '--expected-service-id',
        'b'.repeat(64),
        '--expected-root-path',
        '/srv/maka',
        '--expected-root-id',
        'a'.repeat(64),
      ]),
      {
        kind: 'runtime-host-service-manage',
        action: 'retire',
        json: false,
        framed: true,
        allowInterruptActiveTasks: true,
        expectedTarget: {
          serviceId: 'b'.repeat(64),
          rootPath: '/srv/maka',
          rootId: 'a'.repeat(64),
        },
      },
    );
    assert.equal(parseRuntimeHostCommand(['service', 'retire', '--framed']).kind, 'error');
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'configure',
        '--no-project-roots',
        '--expected-config-fingerprint',
        `sha256:${'c'.repeat(64)}`,
        '--expected-service-id',
        'b'.repeat(64),
        '--expected-root-path',
        '/srv/maka',
        '--expected-root-id',
        'a'.repeat(64),
      ]),
      {
        kind: 'runtime-host-service-manage',
        action: 'configure',
        json: false,
        projectDirectoryRoots: [],
        expectedConfigFingerprint: `sha256:${'c'.repeat(64)}`,
        expectedTarget: {
          serviceId: 'b'.repeat(64),
          rootPath: '/srv/maka',
          rootId: 'a'.repeat(64),
        },
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'update',
        '--framed',
        '--allow-interrupt-active-tasks',
        '--expected-service-id',
        'b'.repeat(64),
        '--expected-root-path',
        '/srv/maka',
        '--expected-root-id',
        'a'.repeat(64),
      ]),
      {
        kind: 'runtime-host-service-update',
        json: false,
        framed: true,
        allowInterruptActiveTasks: true,
        expectedTarget: {
          serviceId: 'b'.repeat(64),
          rootPath: '/srv/maka',
          rootId: 'a'.repeat(64),
        },
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'cleanup-deployment',
        '--expected-service-id',
        'b'.repeat(64),
        '--expected-root-path',
        '/srv/maka',
        '--expected-root-id',
        'a'.repeat(64),
      ]),
      {
        kind: 'runtime-host-managed-deployment-cleanup',
        expectedTarget: {
          serviceId: 'b'.repeat(64),
          rootPath: '/srv/maka',
          rootId: 'a'.repeat(64),
        },
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'status',
        '--framed',
        '--client-data-root',
        '/var/lib/maka-client',
      ]),
      {
        kind: 'runtime-host-service-manage',
        action: 'status',
        json: false,
        framed: true,
        clientDataRoot: '/var/lib/maka-client',
      },
    );
    assert.equal(parseRuntimeHostCommand(['service', 'status', '--root', '/tmp']).kind, 'error');
    assert.equal(
      parseRuntimeHostCommand([
        'setup',
        '--principal',
        'desktop.client-1',
        '--preset',
        'desktop-client',
        '--websocket-path',
        '/runtime host',
      ]).kind,
      'error',
    );
    assert.equal(
      parseRuntimeHostCommand(['service', 'install', '--websocket-path', `/${'x'.repeat(1_000)}`])
        .kind,
      'error',
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'setup',
        '--principal',
        'desktop.client-1',
        '--preset',
        'desktop-client',
        '--client-data-root',
        '/var/lib/maka-client',
        '--defer-pairing-commit',
        '--update-existing',
        '--enable-direct-peer',
        '--coordination-relay',
        '/dns4/discovery.example/udp/443/quic-v1',
        '--json',
      ]),
      {
        kind: 'runtime-host-setup',
        json: true,
        principalId: 'desktop.client-1',
        preset: 'desktop-client',
        clientDataRoot: '/var/lib/maka-client',
        lifecycle: 'supervised',
        deferPairingCommit: true,
        updateExisting: true,
        directPeer: {
          coordinationRelays: ['/dns4/discovery.example/udp/443/quic-v1'],
        },
      },
    );
  });

  it('applies Project roots as a compare-and-set transaction and restores failed changes', async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-runtime-host-configure-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const homeDir = join(base, 'home');
    const firstRoot = join(base, 'first');
    const secondRoot = join(base, 'second');
    const stateRoot = await resolveStorageRoot({
      path: join(base, 'state'),
      kind: 'interactive',
    });
    const clientDataRoot = join(base, 'config');
    const cliPath = join(base, 'maka', 'dist', 'cli.js');
    await Promise.all([
      mkdir(homeDir, { recursive: true }),
      mkdir(firstRoot, { recursive: true }),
      mkdir(secondRoot, { recursive: true }),
      mkdir(dirname(cliPath), { recursive: true }),
    ]);
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
    let state: 'running' | 'stopped' = 'running';
    let retireCalls = 0;
    let failRetirement = false;
    let verifyCalls = 0;
    const startedPolicies: string[][] = [];
    const startPersistedConfig = async () => {
      const persisted = JSON.parse(
        await readFile(resolveRuntimeHostManagedServiceConfigPath(clientDataRoot), 'utf8'),
      ) as RuntimeHostManagedServiceConfig;
      startedPolicies.push(persisted.projectDirectoryRoots.map(({ label }) => label));
      state = 'running';
    };
    const backend: RuntimeHostServiceBackend = {
      ...createUnusedBackend(),
      preflightDeployment: async () => undefined,
      stageDeployment: async () => ({
        apply: startPersistedConfig,
        rollback: async () => undefined,
      }),
      status: async () => ({
        manager: 'systemd_user',
        installed: true,
        enabled: true,
        active: state === 'running',
        state,
        pid: state === 'running' ? 42 : null,
        lastExitCode: 0,
      }),
      retire: async () => {
        retireCalls += 1;
        if (failRetirement) throw new Error('service would not stop');
        state = 'stopped';
      },
      verifyDeployment: async () => {
        verifyCalls += 1;
      },
      start: startPersistedConfig,
    };
    const common = {
      clientDataRoot,
      defaultRootPath: stateRoot.canonicalPath,
      nodePath: process.execPath,
      cliPath,
    } as const;
    const deps = {
      homeDir,
      waitForReady: async () => undefined,
      prepareRetirement: async () => ({ kind: 'active_tasks' as const }),
    };
    const installed = await manageRuntimeHostService(
      { ...common, action: 'install' },
      backend,
      deps,
    );
    assert.equal(installed.service.config?.schemaVersion, 2);
    assert.deepEqual(installed.service.config?.projectDirectoryRoots, [
      { label: '~', path: await realpath(homeDir) },
    ]);
    const installedConfig = installed.service.config;
    assert.ok(installedConfig);
    startedPolicies.length = 0;
    const legacyImplicitHome: RuntimeHostManagedServiceConfig = {
      ...installedConfig,
      schemaVersion: 1,
      projectDirectoryRoots: [],
    };
    assert.deepEqual(effectiveRuntimeHostProjectDirectoryRoots(legacyImplicitHome, homeDir), [
      { label: '~', path: await realpath(homeDir) },
    ]);
    const explicitEmpty: RuntimeHostManagedServiceConfig = {
      ...installedConfig,
      schemaVersion: 2,
      projectDirectoryRoots: [],
    };
    assert.deepEqual(effectiveRuntimeHostProjectDirectoryRoots(explicitEmpty, homeDir), []);
    assert.doesNotMatch(
      runtimeHostServiceLaunchArguments(legacyImplicitHome, '/config/service.json').join(' '),
      /project-root/u,
    );
    assert.doesNotMatch(
      runtimeHostServiceLaunchArguments(explicitEmpty, '/config/service.json').join(' '),
      /project-root/u,
    );
    await assert.rejects(
      manageRuntimeHostService(
        {
          ...common,
          action: 'install',
          projectDirectoryRoots: [{ label: 'First', path: firstRoot }],
        },
        backend,
        deps,
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'configuration_changed',
    );
    assert.deepEqual(
      JSON.parse(await readFile(resolveRuntimeHostManagedServiceConfigPath(clientDataRoot), 'utf8'))
        .projectDirectoryRoots,
      installedConfig.projectDirectoryRoots,
    );
    const expectedTarget = {
      serviceId: resolveRuntimeHostManagedServiceId(clientDataRoot),
      rootPath: stateRoot.canonicalPath,
      rootId: stateRoot.rootId,
    };
    const fingerprint = runtimeHostManagedServiceConfigFingerprint(installedConfig);
    await assert.rejects(
      manageRuntimeHostService(
        {
          ...common,
          action: 'configure',
          expectedTarget,
          expectedConfigFingerprint: fingerprint,
          projectDirectoryRoots: [{ label: 'Missing', path: join(base, 'missing') }],
          allowInterruptActiveTasks: true,
        },
        backend,
        deps,
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'invalid_config',
    );
    assert.equal(retireCalls, 0);
    await assert.rejects(
      manageRuntimeHostService(
        {
          ...common,
          action: 'configure',
          expectedTarget,
          expectedConfigFingerprint: `sha256:${'0'.repeat(64)}`,
          projectDirectoryRoots: [{ label: 'First', path: firstRoot }],
        },
        backend,
        deps,
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'configuration_changed',
    );
    const blocked = await manageRuntimeHostService(
      {
        ...common,
        action: 'configure',
        expectedTarget,
        expectedConfigFingerprint: fingerprint,
        projectDirectoryRoots: [{ label: 'First', path: firstRoot }],
      },
      backend,
      deps,
    );
    assert.equal(blocked.action, 'configure');
    assert.deepEqual(blocked.configuration, { kind: 'active_tasks' });
    assert.equal(retireCalls, 0);
    assert.equal(verifyCalls, 1);

    const configured = await manageRuntimeHostService(
      {
        ...common,
        action: 'configure',
        expectedTarget,
        expectedConfigFingerprint: fingerprint,
        projectDirectoryRoots: [{ label: 'First', path: firstRoot }],
        allowInterruptActiveTasks: true,
      },
      backend,
      {
        ...deps,
        prepareRetirement: async () => ({
          kind: 'prepared' as const,
          hostEpoch: 'host-1',
          pid: 42,
        }),
      },
    );
    assert.equal(configured.action, 'configure');
    assert.deepEqual(configured.configuration, { kind: 'configured' });
    assert.equal(retireCalls, 1);
    assert.equal(verifyCalls, 2);
    assert.deepEqual(startedPolicies, [['First']]);
    assert.deepEqual(configured.service.config?.projectDirectoryRoots, [
      { label: 'First', path: await realpath(firstRoot) },
    ]);

    const configuredConfig = configured.service.config;
    assert.ok(configuredConfig);
    const unchanged = await manageRuntimeHostService(
      {
        ...common,
        action: 'configure',
        expectedTarget,
        expectedConfigFingerprint: runtimeHostManagedServiceConfigFingerprint(configuredConfig),
        projectDirectoryRoots: [{ label: 'First', path: firstRoot }],
      },
      backend,
      deps,
    );
    assert.equal(unchanged.action, 'configure');
    assert.deepEqual(unchanged.configuration, { kind: 'unchanged' });
    assert.equal(retireCalls, 1);

    await assert.rejects(
      manageRuntimeHostService(
        {
          ...common,
          action: 'configure',
          expectedTarget,
          expectedConfigFingerprint: runtimeHostManagedServiceConfigFingerprint(configuredConfig),
          projectDirectoryRoots: [{ label: 'Second', path: secondRoot }],
          allowInterruptActiveTasks: true,
        },
        backend,
        {
          ...deps,
          prepareRetirement: async () => ({
            kind: 'prepared' as const,
            hostEpoch: 'host-2',
            pid: 42,
          }),
          waitForReady: async (config) => {
            if (config.projectDirectoryRoots[0]?.label === 'Second') {
              throw new Error('new policy did not become ready');
            }
          },
        },
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError &&
        error.code === 'configuration_incomplete' &&
        /previous configuration was restored/u.test(error.message),
    );
    const restored = JSON.parse(
      await readFile(resolveRuntimeHostManagedServiceConfigPath(clientDataRoot), 'utf8'),
    ) as RuntimeHostManagedServiceConfig;
    assert.deepEqual(restored.projectDirectoryRoots, configuredConfig.projectDirectoryRoots);
    assert.equal(state, 'running');
    assert.equal(verifyCalls, 3);
    assert.deepEqual(startedPolicies, [['First'], ['Second'], ['First']]);

    await assert.rejects(
      manageRuntimeHostService(
        {
          ...common,
          action: 'configure',
          expectedTarget,
          expectedConfigFingerprint: runtimeHostManagedServiceConfigFingerprint(configuredConfig),
          projectDirectoryRoots: [{ label: 'Second', path: secondRoot }],
          allowInterruptActiveTasks: true,
        },
        backend,
        {
          ...deps,
          prepareRetirement: async () => ({
            kind: 'prepared' as const,
            hostEpoch: 'host-3',
            pid: 42,
          }),
          waitForReady: async (config) => {
            if (config.projectDirectoryRoots[0]?.label === 'Second') {
              failRetirement = true;
              throw new Error('candidate policy did not become ready');
            }
          },
        },
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError &&
        error.code === 'configuration_incomplete' &&
        /configuration was retained/u.test(error.message),
    );
    const retainedCandidate = JSON.parse(
      await readFile(resolveRuntimeHostManagedServiceConfigPath(clientDataRoot), 'utf8'),
    ) as RuntimeHostManagedServiceConfig;
    assert.deepEqual(retainedCandidate.projectDirectoryRoots, [
      { label: 'Second', path: await realpath(secondRoot) },
    ]);
    assert.equal(state, 'running');

    failRetirement = false;
    const configPath = resolveRuntimeHostManagedServiceConfigPath(clientDataRoot);
    await assert.rejects(
      manageRuntimeHostService(
        {
          ...common,
          action: 'configure',
          expectedTarget,
          expectedConfigFingerprint: runtimeHostManagedServiceConfigFingerprint(retainedCandidate),
          projectDirectoryRoots: [{ label: 'First', path: firstRoot }],
          allowInterruptActiveTasks: true,
        },
        backend,
        {
          ...deps,
          prepareRetirement: async () => ({
            kind: 'prepared' as const,
            hostEpoch: 'host-4',
            pid: 42,
          }),
          waitForReady: async (config) => {
            if (config.projectDirectoryRoots[0]?.label === 'First') {
              await writeFile(configPath, '{"schemaVersion":999}\n', 'utf8');
              throw new Error('candidate corrupted the persisted revision');
            }
          },
        },
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError &&
        error.code === 'configuration_incomplete' &&
        /remains stopped for inspection/u.test(error.message),
    );
    assert.equal(state, 'stopped');
  });

  it('restores install config only after the candidate process is quiescent', async (t) => {
    const base = await realpath(
      await mkdtemp(join(tmpdir(), 'maka-runtime-host-install-rollback-')),
    );
    t.after(() => rm(base, { recursive: true, force: true }));
    const stateRoot = await resolveStorageRoot({
      path: join(base, 'state'),
      kind: 'interactive',
    });
    const projectRoot = join(base, 'projects');
    const clientDataRoot = join(base, 'config');
    const cliPath = join(base, 'maka', 'dist', 'cli.js');
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(dirname(cliPath), { recursive: true }),
      mkdir(clientDataRoot, { recursive: true }),
    ]);
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
    const configPath = resolveRuntimeHostManagedServiceConfigPath(clientDataRoot);
    const previous: RuntimeHostManagedServiceConfig = {
      schemaVersion: 2,
      rootPath: stateRoot.canonicalPath,
      projectDirectoryRoots: [{ label: 'Projects', path: await realpath(projectRoot) }],
      websocket: { host: '127.0.0.1', port: 7443, path: '/runtime-host' },
      launch: { nodePath: await realpath(process.execPath), cliPath: await realpath(cliPath) },
    };
    await writeFile(configPath, `${JSON.stringify(previous, null, 2)}\n`, 'utf8');
    let active = true;
    let rollbackLoadedPort: number | undefined;
    const backend: RuntimeHostServiceBackend = {
      ...createReadyBackend(),
      stageDeployment: async () => ({
        apply: async () => {
          active = true;
          throw new Error('candidate deployment failed');
        },
        rollback: async () => {
          assert.equal(active, false);
          rollbackLoadedPort = (
            JSON.parse(await readFile(configPath, 'utf8')) as RuntimeHostManagedServiceConfig
          ).websocket.port;
          active = true;
        },
      }),
      status: async () => ({
        manager: 'systemd_user',
        installed: true,
        enabled: true,
        active,
        state: active ? 'running' : 'stopped',
        pid: active ? 42 : null,
        lastExitCode: 0,
      }),
      retire: async () => {
        active = false;
      },
    };

    await assert.rejects(
      manageRuntimeHostService(
        {
          action: 'install',
          clientDataRoot,
          defaultRootPath: stateRoot.canonicalPath,
          websocketPort: 8443,
          nodePath: process.execPath,
          cliPath,
        },
        backend,
        { waitForReady: async () => undefined },
      ),
      /candidate deployment failed/u,
    );
    assert.equal(rollbackLoadedPort, 7443);
    assert.equal(
      (JSON.parse(await readFile(configPath, 'utf8')) as RuntimeHostManagedServiceConfig).websocket
        .port,
      7443,
    );
    assert.equal(active, true);
  });

  it('migrates and restores an exact legacy systemd deployment inside configure', async (t) => {
    const base = await realpath(
      await mkdtemp(join(tmpdir(), 'maka-runtime-host-legacy-configure-')),
    );
    t.after(() => rm(base, { recursive: true, force: true }));
    const clientDataRoot = join(base, 'config');
    const configPath = resolveRuntimeHostManagedServiceConfigPath(clientDataRoot);
    const cliPath = join(base, 'maka', 'dist', 'cli.js');
    const oldProjectRoot = join(base, 'old-projects');
    const newProjectRoot = join(base, 'new-projects');
    const root = await resolveStorageRoot({ path: join(base, 'state'), kind: 'interactive' });
    await Promise.all([
      mkdir(dirname(cliPath), { recursive: true }),
      mkdir(dirname(configPath), { recursive: true }),
      mkdir(oldProjectRoot, { recursive: true }),
      mkdir(newProjectRoot, { recursive: true }),
    ]);
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
    const legacyConfig: RuntimeHostManagedServiceConfig = {
      schemaVersion: 1,
      rootPath: root.canonicalPath,
      projectDirectoryRoots: [{ label: 'Old', path: await realpath(oldProjectRoot) }],
      websocket: { host: '127.0.0.1', port: 7443, path: '/runtime-host' },
      launch: { nodePath: await realpath(process.execPath), cliPath: await realpath(cliPath) },
    };
    await writeFile(configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, 'utf8');
    const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
    const unitPath = resolveSystemdUserRuntimeHostServicePath(serviceId, {
      XDG_CONFIG_HOME: base,
    });
    await mkdir(dirname(unitPath), { recursive: true });
    const legacyUnit = legacySystemdUnitFixture(legacyConfig);
    await writeFile(unitPath, legacyUnit, 'utf8');
    const systemd = createFakeSystemd(unitPath);
    const unitName = basename(unitPath);
    await systemd.run(['enable', unitName]);
    await systemd.run(['start', unitName]);
    const backend = () =>
      createSystemdUserRuntimeHostService(serviceId, {
        serviceConfigPath: configPath,
        env: { XDG_CONFIG_HOME: base },
        homeDir: base,
        uid: 1000,
        runSystemctl: systemd.run,
        runLoginctl: async () => success('yes\n'),
      });
    await assert.rejects(
      backend().verifyDeployment(legacyConfig),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'target_mismatch',
    );
    await backend().verifyDeployment(legacyConfig, { acceptLegacyConfigLaunch: true });
    const input = {
      action: 'configure' as const,
      clientDataRoot,
      defaultRootPath: root.canonicalPath,
      nodePath: process.execPath,
      cliPath,
      expectedTarget: {
        serviceId,
        rootPath: root.canonicalPath,
        rootId: root.rootId,
      },
      expectedConfigFingerprint: runtimeHostManagedServiceConfigFingerprint(legacyConfig),
      projectDirectoryRoots: [{ label: 'New', path: newProjectRoot }],
      allowInterruptActiveTasks: true,
    } as const;
    let failCandidate = true;
    const deps = {
      homeDir: base,
      platform: 'linux' as const,
      prepareRetirement: async (_config: RuntimeHostManagedServiceConfig, pid: number) => ({
        kind: 'prepared' as const,
        hostEpoch: 'legacy-host',
        pid,
      }),
      waitForReady: async (config: RuntimeHostManagedServiceConfig) => {
        if (config.schemaVersion === 2 && failCandidate) {
          failCandidate = false;
          throw new Error('migrated candidate failed readiness');
        }
      },
    };

    await assert.rejects(
      manageRuntimeHostService(input, backend(), deps),
      /previous configuration was restored/u,
    );
    assert.equal(await readFile(unitPath, 'utf8'), legacyUnit);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), legacyConfig);

    const configured = await manageRuntimeHostService(input, backend(), deps);
    assert.equal(configured.action, 'configure');
    if (configured.action !== 'configure') assert.fail('Expected configure result');
    assert.deepEqual(configured.configuration, { kind: 'configured' });
    assert.equal(configured.service.config?.schemaVersion, 2);
    assert.match(await readFile(unitPath, 'utf8'), /--managed-service-config/u);
    assert.doesNotMatch(await readFile(unitPath, 'utf8'), /--project-root/u);
  });

  it('installs, reports, and cleanly uninstalls while retaining the State Root', async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    const homeDir = join(base, 'home');
    const clientDataRoot = join(base, 'config', 'Maka');
    const rootPath = join(base, 'state root');
    const projectPath = join(base, 'projects');
    await writeFile(join(base, 'placeholder'), '', 'utf8');
    await Promise.all([
      mkdir(homeDir, { recursive: true }),
      mkdir(projectPath, { recursive: true }),
    ]);
    const env = {
      XDG_CONFIG_HOME: join(base, 'xdg-config'),
      XDG_DATA_HOME: join(base, 'xdg-data'),
    };
    const configPath = resolveRuntimeHostManagedServiceConfigPath(clientDataRoot);
    const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
    const deploymentRoot = resolveRuntimeHostManagedDeploymentRoot(serviceId, {
      env,
      homeDir,
      platform: 'linux',
    });
    const cliPath = join(deploymentRoot, 'versions', '0.2.0', 'dist', 'cli.js');
    await mkdir(dirname(cliPath), { recursive: true });
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
    const canonicalCliPath = await realpath(cliPath);
    const unitPath = resolveSystemdUserRuntimeHostServicePath(serviceId, env, homeDir);
    const systemd = createFakeSystemd(unitPath);
    const backend = () =>
      createSystemdUserRuntimeHostService(serviceId, {
        serviceConfigPath: configPath,
        env,
        homeDir,
        uid: 1000,
        runSystemctl: systemd.run,
        runLoginctl: async () => success('yes\n'),
      });
    const common = {
      clientDataRoot,
      defaultRootPath: rootPath,
      nodePath: process.execPath,
      cliPath: canonicalCliPath,
    } as const;
    const managerDeps = {
      allocateLoopbackPort: async () => 49_999,
      waitForReady: async () => undefined,
      prepareRetirement: async (_config: unknown, pid: number) => ({
        kind: 'prepared' as const,
        hostEpoch: 'test-host',
        pid,
      }),
      environment: env,
      homeDir,
      platform: 'linux' as const,
    } as const;

    const installed = await manageRuntimeHostService(
      {
        ...common,
        action: 'install',
        projectDirectoryRoots: [{ label: 'Projects', path: projectPath }],
        websocketPort: 47_777,
      },
      backend(),
      managerDeps,
    );
    assert.equal(installed.service.active, true);
    assert.notEqual(installed.service.config, null);
    assert.equal(installed.service.enabled, true);
    assert.equal(installed.service.config?.websocket.port, 47_777);
    assert.match(await readFile(unitPath, 'utf8'), /ExecStart=.*runtime-host.*serve/u);
    const updateServicePath = resolveSystemdUserRuntimeHostUpdateServicePath(
      serviceId,
      env,
      homeDir,
    );
    const updateTimerPath = resolveSystemdUserRuntimeHostUpdateTimerPath(serviceId, env, homeDir);
    assert.match(await readFile(updateServicePath, 'utf8'), /operator.*reconcile-update/u);
    assert.match(await readFile(updateTimerPath, 'utf8'), /^OnUnitInactiveSec=86400s$/mu);
    const resetFailed = systemd.calls.findIndex(([command]) => command === 'reset-failed');
    const restart = systemd.calls.findIndex(([command]) => command === 'restart');
    assert.ok(resetFailed >= 0 && resetFailed < restart);

    const reinstalled = await manageRuntimeHostService(
      { ...common, action: 'install' },
      backend(),
      managerDeps,
    );
    assert.equal(reinstalled.service.config?.websocket.port, 47_777);
    assert.deepEqual(reinstalled.service.config?.projectDirectoryRoots, [
      { label: 'Projects', path: await realpath(projectPath) },
    ]);
    assert.equal(reinstalled.service.lastExitCode, 0);
    assert.equal(
      systemd.calls.filter(
        ([command, target]) => command === 'restart' && target === basename(updateTimerPath),
      ).length,
      1,
    );
    const managedConfig = reinstalled.service.config;
    assert.ok(managedConfig);
    const repairBackend = backend();
    const updateTimerName = basename(updateTimerPath);
    systemd.setUnitDropInPaths(updateTimerName, ['/tmp/update-timer-override.conf']);
    await assert.rejects(repairBackend.stageDeployment(), /systemd drop-in overrides/u);
    systemd.setUnitDropInPaths(updateTimerName, []);
    await writeFile(updateTimerPath, '[Timer]\n# stale\n', 'utf8');
    await assert.rejects(
      repairBackend.verifyReplacementPreconditions(managedConfig),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'target_mismatch',
    );
    await assert.rejects(
      repairBackend.verifyDeployment(managedConfig),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'target_mismatch',
    );
    await applyStagedDeployment(repairBackend, managedConfig);
    await repairBackend.verifyDeployment(managedConfig);

    const updateServiceName = basename(updateServicePath);
    systemd.activateUnitWhenStopping(updateTimerName, updateServiceName);
    await repairBackend.stop();
    assert.ok(
      systemd.calls.some(
        ([command, ...targets]) =>
          command === 'stop' &&
          targets.includes(updateTimerName) &&
          targets.includes(updateServiceName),
      ),
    );
    await repairBackend.verifyDeployment(managedConfig);
    await assert.rejects(
      repairBackend.verifyDeployment(managedConfig, { requireSchedulerReady: true }),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'target_mismatch',
    );
    const inactiveInstallCalls = systemd.calls.length;
    await applyStagedDeployment(repairBackend, managedConfig, { activate: false });
    assert.equal((await repairBackend.status()).state, 'stopped');
    assert.equal(
      systemd.calls
        .slice(inactiveInstallCalls)
        .some(([command]) => command === 'start' || command === 'restart'),
      false,
    );
    await repairBackend.replace(managedConfig);
    assert.ok(
      systemd.calls.some(([command, target]) => command === 'start' && target === updateTimerName),
    );
    await repairBackend.verifyDeployment(managedConfig, { requireSchedulerReady: true });

    const diagnosticBackend = createSystemdUserRuntimeHostService(serviceId, {
      serviceConfigPath: configPath,
      env,
      homeDir,
      uid: 1000,
      runSystemctl: systemd.run,
      runLoginctl: async () => success('yes\n'),
      runJournalctl: async (args) =>
        success(
          args.includes(updateServiceName)
            ? 'scheduler reconciliation failed'
            : 'h'.repeat(RUNTIME_HOST_SERVICE_LOG_MAX_BYTES),
        ),
    });
    const logs = await diagnosticBackend.logs();
    assert.match(logs, /scheduler reconciliation failed/u);
    assert.ok(Buffer.byteLength(logs) <= RUNTIME_HOST_SERVICE_LOG_MAX_BYTES);

    const { managedDeploymentRoot: _managedDeploymentRoot, ...unmanagedConfig } = managedConfig;
    await applyStagedDeployment(repairBackend, unmanagedConfig);
    await repairBackend.verifyDeployment(unmanagedConfig);
    await assert.rejects(readFile(updateServicePath, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(updateTimerPath, 'utf8'), { code: 'ENOENT' });
    await repairBackend.verifyReplacementPreconditions(managedConfig);
    await repairBackend.replace(managedConfig);
    await repairBackend.verifyDeployment(managedConfig);

    const root = await resolveStorageRoot({ path: rootPath, kind: 'interactive' });
    await writeFile(configPath, '{not-json', 'utf8');
    const repaired = await manageRuntimeHostService(
      {
        ...common,
        action: 'install',
        expectedTarget: {
          serviceId,
          rootPath: root.canonicalPath,
          rootId: root.rootId,
        },
      },
      backend(),
      managerDeps,
    );
    assert.equal(repaired.service.config?.managedDeploymentRoot, await realpath(deploymentRoot));
    assert.equal(repaired.service.config?.websocket.port, 49_999);

    const globalCliPath = join(base, 'global', 'cli.js');
    await mkdir(dirname(globalCliPath), { recursive: true });
    await writeFile(globalCliPath, '#!/usr/bin/env node\n', 'utf8');
    await assert.rejects(
      manageRuntimeHostService(
        {
          action: 'install',
          clientDataRoot,
          defaultRootPath: rootPath,
          nodePath: process.execPath,
          cliPath: globalCliPath,
        },
        backend(),
        managerDeps,
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'invalid_launch',
    );

    await writeFile(configPath, '{not-json', 'utf8');
    const retained = await manageRuntimeHostService(
      {
        ...common,
        action: 'uninstall',
        retainManagedDeployment: true,
        expectedTarget: {
          serviceId,
          rootPath: root.canonicalPath,
          rootId: root.rootId,
        },
      },
      backend(),
      managerDeps,
    );
    assert.equal(retained.service.installed, false);
    await access(deploymentRoot);

    await manageRuntimeHostService({ ...common, action: 'install' }, backend(), managerDeps);
    const expectedTarget = {
      serviceId,
      rootPath: root.canonicalPath,
      rootId: root.rootId,
    } as const;
    const updatePolicy = {
      schemaVersion: 1 as const,
      policy: { kind: 'channel' as const, channel: 'latest' as const },
      target: expectedTarget,
    };
    await writeRuntimeHostManagedUpdatePolicy(deploymentRoot, updatePolicy);
    await writeFile(configPath, '{not-json', 'utf8');
    await manageRuntimeHostService(
      {
        ...common,
        cliPath: globalCliPath,
        action: 'uninstall',
        retainManagedDeployment: true,
        expectedTarget,
      },
      backend(),
      managerDeps,
    );
    assert.equal(await readRuntimeHostManagedUpdatePolicy(deploymentRoot), null);
    await access(deploymentRoot);

    await manageRuntimeHostService({ ...common, action: 'install' }, backend(), managerDeps);
    assert.equal(await readRuntimeHostManagedUpdatePolicy(deploymentRoot), null);
    await writeRuntimeHostManagedUpdatePolicy(deploymentRoot, updatePolicy);
    await assert.rejects(
      manageRuntimeHostService(
        {
          ...common,
          action: 'uninstall',
          expectedTarget: { ...expectedTarget, rootId: 'f'.repeat(64) },
        },
        backend(),
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'target_mismatch',
    );
    assert.deepEqual(await readRuntimeHostManagedUpdatePolicy(deploymentRoot), updatePolicy);
    await assert.rejects(
      cleanupRuntimeHostManagedDeployment(
        { clientDataRoot, cliPath: canonicalCliPath, expectedTarget },
        backend(),
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'uninstall_incomplete',
    );
    await access(deploymentRoot);
    await manageRuntimeHostService(
      {
        ...common,
        action: 'uninstall',
        retainManagedDeployment: true,
        expectedTarget,
      },
      backend(),
      managerDeps,
    );
    assert.equal(await readRuntimeHostManagedUpdatePolicy(deploymentRoot), null);
    await cleanupRuntimeHostManagedDeployment(
      { clientDataRoot, cliPath: canonicalCliPath, expectedTarget },
      backend(),
    );
    await assert.rejects(access(deploymentRoot));

    const movedRootPath = `${rootPath}-moved`;
    await rename(rootPath, movedRootPath);

    const repeatedRetain = await manageRuntimeHostService(
      {
        ...common,
        action: 'uninstall',
        retainManagedDeployment: true,
        expectedTarget: {
          serviceId,
          rootPath: root.canonicalPath,
          rootId: root.rootId,
        },
      },
      backend(),
    );
    assert.equal(repeatedRetain.service.installed, false);

    const uninstalled = await manageRuntimeHostService(
      {
        ...common,
        action: 'uninstall',
        expectedTarget: {
          serviceId,
          rootPath: root.canonicalPath,
          rootId: root.rootId,
        },
      },
      backend(),
    );
    assert.equal(uninstalled.service.installed, false);
    assert.equal(uninstalled.service.config, null);
    assert.equal(uninstalled.service.state, 'not_installed');
    assert.equal(uninstalled.retainedStateRoot, root.canonicalPath);
    await access(movedRootPath);
    await assert.rejects(access(configPath));
    await assert.rejects(access(unitPath));
    await assert.rejects(access(updateServicePath));
    await assert.rejects(access(updateTimerPath));
    await assert.rejects(access(deploymentRoot));

    const repeated = await manageRuntimeHostService(
      { ...common, action: 'uninstall', expectedTarget },
      backend(),
    );
    assert.equal(repeated.service.installed, false);
  });

  it('refuses to remove a managed deployment through a redirected ancestor', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-symlink-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const clientDataRoot = join(base, 'config');
    const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
    const deploymentRoot = join(base, 'data', 'Maka', 'runtime-host-services', serviceId);
    const outsideRoot = join(base, 'outside', 'Maka', 'runtime-host-services', serviceId);
    await mkdir(deploymentRoot, { recursive: true });
    const outsideCli = join(outsideRoot, 'versions', '1.0.0', 'dist', 'cli.js');
    await mkdir(dirname(outsideCli), { recursive: true });
    await writeFile(outsideCli, '#!/usr/bin/env node\n', 'utf8');
    await writeFile(join(outsideRoot, 'sentinel'), 'outside', 'utf8');
    await rename(join(base, 'data', 'Maka'), join(base, 'data', 'Maka-original'));
    await symlink(join(base, 'outside', 'Maka'), join(base, 'data', 'Maka'));

    await assert.rejects(
      removeRuntimeHostManagedDeployment(deploymentRoot, serviceId),
      /redirected managed Runtime Host deployment path/u,
    );
    assert.equal(await readFile(join(outsideRoot, 'sentinel'), 'utf8'), 'outside');
    await assert.rejects(
      manageRuntimeHostService(
        {
          action: 'uninstall',
          clientDataRoot,
          defaultRootPath: join(base, 'state'),
          nodePath: process.execPath,
          cliPath: join(deploymentRoot, 'versions', '1.0.0', 'dist', 'cli.js'),
          expectedTarget: {
            serviceId,
            rootPath: join(base, 'state'),
            rootId: 'a'.repeat(64),
          },
        },
        createReadyBackend(),
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'uninstall_incomplete',
    );
    assert.equal(await readFile(join(outsideRoot, 'sentinel'), 'utf8'), 'outside');
  });

  it('isolates managed services by Client Data Root without mutating on status', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-profile-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const homeDir = join(base, 'home');
    const env = { XDG_CONFIG_HOME: join(base, 'xdg-config') };
    const cliPath = join(base, 'cli.js');
    const releaseRoot = join(base, 'profiles', 'Maka');
    const developmentRoot = join(base, 'profiles', 'Maka Dev');
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');

    const createProfile = (clientDataRoot: string) => {
      const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
      const unitPath = resolveSystemdUserRuntimeHostServicePath(serviceId, env, homeDir);
      const systemd = createFakeSystemd(unitPath);
      return {
        unitPath,
        systemd,
        backend: createSystemdUserRuntimeHostService(serviceId, {
          serviceConfigPath: resolveRuntimeHostManagedServiceConfigPath(clientDataRoot),
          env,
          homeDir,
          uid: 1000,
          runSystemctl: systemd.run,
          runLoginctl: async () => success('yes\n'),
        }),
      };
    };
    const release = createProfile(releaseRoot);
    const development = createProfile(developmentRoot);
    assert.notEqual(release.unitPath, development.unitPath);

    const input = (clientDataRoot: string) => ({
      clientDataRoot,
      defaultRootPath: join(clientDataRoot, 'workspaces', 'default'),
      nodePath: process.execPath,
      cliPath,
    });
    const status = await manageRuntimeHostService(
      { ...input(releaseRoot), action: 'status' },
      release.backend,
    );
    assert.equal(status.service.installed, false);
    await assert.rejects(access(releaseRoot));
    await assert.rejects(access(dirname(release.unitPath)));

    const ready = { waitForReady: async () => undefined } as const;
    await manageRuntimeHostService(
      { ...input(releaseRoot), action: 'install' },
      release.backend,
      ready,
    );
    const releaseConfig = (
      await manageRuntimeHostService({ ...input(releaseRoot), action: 'status' }, release.backend)
    ).service.config;
    assert.ok(releaseConfig);
    await release.backend.verifyDeployment(releaseConfig);
    const unit = await readFile(release.unitPath, 'utf8');
    await writeFile(release.unitPath, `${unit}# stale change\n`);
    await assert.rejects(
      release.backend.verifyDeployment(releaseConfig),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'target_mismatch',
    );
    await writeFile(release.unitPath, unit);
    release.systemd.setDropInPaths(['/home/ada/.config/systemd/user/override.conf']);
    await assert.rejects(
      release.backend.verifyDeployment(releaseConfig),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'target_mismatch',
    );
    release.systemd.setDropInPaths([]);
    await manageRuntimeHostService(
      { ...input(developmentRoot), action: 'install' },
      development.backend,
      ready,
    );
    const developmentStateRoot = await resolveStorageRoot({
      path: input(developmentRoot).defaultRootPath,
      kind: 'interactive',
    });
    await development.backend.stop();
    await manageRuntimeHostService(
      {
        ...input(developmentRoot),
        action: 'uninstall',
        expectedTarget: {
          serviceId: resolveRuntimeHostManagedServiceId(developmentRoot),
          rootPath: developmentStateRoot.canonicalPath,
          rootId: developmentStateRoot.rootId,
        },
      },
      development.backend,
    );

    await access(release.unitPath);
    await access(resolveRuntimeHostManagedServiceConfigPath(releaseRoot));
    assert.equal(
      (await manageRuntimeHostService({ ...input(releaseRoot), action: 'status' }, release.backend))
        .service.active,
      true,
    );
  });

  it('quotes systemd arguments without exposing specifier or environment expansion', () => {
    const config: RuntimeHostManagedServiceConfig = {
      schemaVersion: 1,
      rootPath: '/srv/Maka $100%',
      projectDirectoryRoots: [{ label: 'Cash$', path: '/home/$ada/My Projects' }],
      websocket: { host: '127.0.0.1', port: 7443, path: '/runtime-host' },
      launch: {
        nodePath: '/opt/$Node 24/bin/node',
        cliPath: '/opt/Maka/$current/cli.js',
      },
    };
    const unit = renderSystemdUnit(config, '/srv/Maka $100%/runtime-host-service.json');
    assert.match(unit, /"\/srv\/Maka \$\$100%%\/runtime-host-service\.json"/u);
    assert.match(unit, /"\/opt\/\$\$Node 24\/bin\/node"/u);
    assert.match(unit, /"\/opt\/Maka\/\$\$current\/cli\.js"/u);
    assert.match(unit, /^Restart=on-failure$/mu);
    assert.match(unit, /^StartLimitIntervalSec=60s$/mu);
    assert.match(unit, /^StartLimitBurst=5$/mu);

    const managed = { ...config, managedDeploymentRoot: '/opt/Maka/$managed root' };
    const updateService = renderSystemdUpdateService(managed);
    const updateTimer = renderSystemdUpdateTimer('a'.repeat(64));
    assert.match(updateService, /"\/opt\/Maka\/\$\$managed root\/operator"/u);
    assert.match(updateService, /"reconcile-update" "--framed"/u);
    assert.match(updateTimer, /^OnActiveSec=900s$/mu);
    assert.match(updateTimer, /^OnUnitInactiveSec=86400s$/mu);
    assert.match(updateTimer, /^RandomizedDelaySec=3600s$/mu);
  });

  it('emits one stable machine error for an unmet service prerequisite', async () => {
    let output = '';
    const exitCode = await runManagedRuntimeHostServiceCli(
      {
        action: 'install',
        json: true,
        clientDataRoot: '/config/Maka',
        defaultRootPath: '/config/Maka/workspaces/default',
        nodePath: '/usr/bin/node',
        cliPath: '/opt/maka/cli.js',
      },
      {
        manage: async () => {
          throw new RuntimeHostServiceManagerError(
            'linger_disabled',
            'Persistent user services are disabled',
          );
        },
        withDeploymentLock: async (_root, operation) => operation(),
        withLifecycleLock: async (_root, operation) => operation(),
        createBackend: createUnusedBackend,
        writeOutput: (value) => {
          output += value;
        },
      },
    );
    assert.equal(exitCode, 1);
    assert.deepEqual(JSON.parse(output), {
      schemaVersion: 1,
      ok: false,
      action: 'install',
      error: {
        code: 'linger_disabled',
        message: 'Persistent user services are disabled',
      },
    });
  });

  it('emits bounded retirement facts in framed output', async () => {
    let output = '';
    let deploymentLocked = false;
    let lifecycleLocked = false;
    const exitCode = await runManagedRuntimeHostServiceCli(
      {
        action: 'retire',
        json: false,
        framed: true,
        clientDataRoot: '/config/Maka',
        defaultRootPath: '/config/Maka/workspaces/default',
        nodePath: '/usr/bin/node',
        cliPath: '/opt/maka/cli.js',
      },
      {
        manage: async () => {
          assert.equal(deploymentLocked, true);
          assert.equal(lifecycleLocked, true);
          return {
            schemaVersion: 1,
            action: 'retire',
            service: {
              manager: 'systemd_user',
              installed: true,
              enabled: true,
              active: false,
              state: 'stopped',
              pid: null,
              lastExitCode: 0,
              installedVersion: '1.2.3',
              config: null,
            },
            retirement: { kind: 'retired', hostEpoch: 'host-1', pid: 42 },
          };
        },
        withDeploymentLock: async (_root, operation) => {
          deploymentLocked = true;
          try {
            return await operation();
          } finally {
            deploymentLocked = false;
          }
        },
        withLifecycleLock: async (_root, operation) => {
          assert.equal(deploymentLocked, true);
          lifecycleLocked = true;
          try {
            return await operation();
          } finally {
            lifecycleLocked = false;
          }
        },
        createBackend: createUnusedBackend,
        writeOutput: (value) => {
          output += value;
        },
      },
    );
    assert.equal(exitCode, 0);
    const frame = decodeRuntimeHostServiceManagementFrame(output);
    assert.equal(frame?.kind, 'result');
    assert.deepEqual(
      frame?.kind === 'result' && frame.action === 'retire' ? frame.retirement : null,
      {
        kind: 'retired',
        hostEpoch: 'host-1',
        pid: 42,
      },
    );
  });

  it('reports active work as a blocked retirement result', async () => {
    const service = {
      manager: 'systemd_user',
      installed: true,
      enabled: true,
      active: true,
      state: 'running',
      pid: 42,
      lastExitCode: 0,
      installedVersion: '1.2.3',
      config: null,
    } as const;
    const run = async (framed: boolean) => {
      let output = '';
      const exitCode = await runManagedRuntimeHostServiceCli(
        {
          action: 'retire',
          json: !framed,
          framed,
          clientDataRoot: '/config/Maka',
          defaultRootPath: '/config/Maka/workspaces/default',
          nodePath: '/usr/bin/node',
          cliPath: '/opt/maka/cli.js',
        },
        {
          manage: async () => ({
            schemaVersion: 1,
            action: 'retire',
            service,
            retirement: { kind: 'active_tasks' },
          }),
          withDeploymentLock: async (_root, operation) => operation(),
          withLifecycleLock: async (_root, operation) => operation(),
          createBackend: createUnusedBackend,
          writeOutput: (value) => {
            output += value;
          },
        },
      );
      return { exitCode, output };
    };

    const json = await run(false);
    assert.equal(json.exitCode, 1);
    assert.deepEqual(JSON.parse(json.output), {
      schemaVersion: 1,
      action: 'retire',
      service,
      retirement: { kind: 'active_tasks' },
      ok: false,
    });

    const framed = await run(true);
    assert.equal(framed.exitCode, 1);
    const frame = decodeRuntimeHostServiceManagementFrame(framed.output);
    assert.deepEqual(
      frame?.kind === 'result' && frame.action === 'retire' ? frame.retirement : null,
      { kind: 'active_tasks' },
    );
  });

  it('projects requested operator capabilities without launch configuration', async (t) => {
    const previousCapabilityRequest = process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV];
    const previousConfigurationRequest =
      process.env[RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV];
    delete process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV];
    delete process.env[RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV];
    t.after(() => {
      if (previousCapabilityRequest === undefined) {
        delete process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV];
      } else {
        process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV] = previousCapabilityRequest;
      }
      if (previousConfigurationRequest === undefined) {
        delete process.env[RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV];
      } else {
        process.env[RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV] =
          previousConfigurationRequest;
      }
    });
    const options = {
      action: 'status' as const,
      json: false,
      framed: true,
      clientDataRoot: '/config/Maka',
      defaultRootPath: '/config/Maka/workspaces/default',
      nodePath: '/usr/bin/node',
      cliPath: '/opt/maka/cli.js',
    };
    const manage = async (): Promise<RuntimeHostManagedServiceResult> => ({
      schemaVersion: 1 as const,
      action: 'status' as const,
      service: {
        manager: 'systemd_user' as const,
        installed: true,
        enabled: true,
        active: true,
        state: 'running' as const,
        pid: 42,
        lastExitCode: 0,
        installedVersion: '1.2.3',
        config: {
          schemaVersion: 1 as const,
          rootPath: '/srv/maka',
          projectDirectoryRoots: [{ label: 'Home', path: '/home/ada' }],
          websocket: { host: '127.0.0.1', port: 7443, path: '/runtime-host' },
          launch: { nodePath: '/secret/node', cliPath: '/secret/cli.js' },
        },
      },
    });
    const run = async () => {
      let output = '';
      const exitCode = await runManagedRuntimeHostServiceCli(options, {
        manage,
        createBackend: createUnusedBackend,
        writeOutput: (value) => {
          output += value;
        },
      });
      assert.equal(exitCode, 0);
      return output;
    };

    const legacyFrame = decodeRuntimeHostServiceManagementFrame(await run());
    assert.equal(legacyFrame?.kind, 'result');
    assert.equal(
      legacyFrame?.kind === 'result' && legacyFrame.action === 'status'
        ? legacyFrame.operatorCapabilities
        : undefined,
      undefined,
    );

    process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV] =
      RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY;
    const frame = decodeRuntimeHostServiceManagementFrame(await run());
    assert.equal(frame?.kind, 'result');
    if (frame?.kind !== 'result' || frame.action !== 'status') {
      assert.fail('Expected a service status result frame');
    }
    assert.equal(frame.service.installedVersion, '1.2.3');
    assert.deepEqual(frame.operatorCapabilities, ['access-management-v1']);
    assert.equal(frame.service.stateRoot, '/srv/maka');
    assert.equal(frame.service.configurationFingerprint, undefined);
    assert.doesNotMatch(JSON.stringify(frame), /secret/u);

    const futureFrame = decodeRuntimeHostServiceManagementFrame(
      encodeRuntimeHostServiceManagementFrame({
        ...frame,
        operatorCapabilities: ['future-management-v2'],
      }),
    );
    assert.deepEqual(
      futureFrame?.kind === 'result' && futureFrame.action === 'status'
        ? futureFrame.operatorCapabilities
        : undefined,
      ['future-management-v2'],
    );

    process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV] =
      RUNTIME_HOST_OPERATOR_PEER_MANAGEMENT_CAPABILITY;
    const peerFrame = decodeRuntimeHostServiceManagementFrame(await run());
    assert.deepEqual(
      peerFrame?.kind === 'result' && peerFrame.action === 'status'
        ? peerFrame.operatorCapabilities
        : undefined,
      [RUNTIME_HOST_OPERATOR_PEER_MANAGEMENT_CAPABILITY],
    );

    process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV] =
      RUNTIME_HOST_OPERATOR_PEER_RELAY_DISCOVERY_CAPABILITY;
    const relayDiscoveryFrame = decodeRuntimeHostServiceManagementFrame(await run());
    assert.deepEqual(
      relayDiscoveryFrame?.kind === 'result' && relayDiscoveryFrame.action === 'status'
        ? relayDiscoveryFrame.operatorCapabilities
        : undefined,
      [RUNTIME_HOST_OPERATOR_PEER_RELAY_DISCOVERY_CAPABILITY],
    );

    process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV] =
      RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY;
    process.env[RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV] = '1';
    const configurationFrame = decodeRuntimeHostServiceManagementFrame(await run());
    if (configurationFrame?.kind !== 'result' || configurationFrame.action !== 'status') {
      assert.fail('Expected a configuration-capable service status result frame');
    }
    assert.deepEqual(configurationFrame.operatorCapabilities, [
      RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY,
    ]);
    assert.match(
      configurationFrame.service.configurationFingerprint ?? '',
      /^sha256:[a-f0-9]{64}$/u,
    );
    delete process.env[RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV];

    process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV] =
      RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY;
    const lockFrame = decodeRuntimeHostServiceManagementFrame(await run());
    assert.deepEqual(
      lockFrame?.kind === 'result' && lockFrame.action === 'status'
        ? lockFrame.operatorCapabilities
        : undefined,
      ['process-lifetime-lock-v1'],
    );
  });

  it('reads service logs when an interrupted install left no config', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-logs-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const backend: RuntimeHostServiceBackend = {
      ...createReadyBackend(),
      logs: async () => 'failed before config commit',
    };

    const result = await manageRuntimeHostService(
      {
        action: 'logs',
        clientDataRoot: join(base, 'config'),
        defaultRootPath: join(base, 'state'),
        nodePath: process.execPath,
        cliPath: join(base, 'cli.js'),
      },
      backend,
    );

    assert.equal(result.logs, 'failed before config commit');
    assert.equal(result.service.config, null);
  });

  it('verifies the bound service and State Root before management mutations', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-binding-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const clientDataRoot = join(base, 'config');
    const root = await resolveStorageRoot({ path: join(base, 'state'), kind: 'interactive' });
    const cliPath = join(base, 'cli.js');
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
    let starts = 0;
    const backend: RuntimeHostServiceBackend = {
      ...createReadyBackend(),
      start: async () => {
        starts += 1;
      },
    };
    const common = {
      clientDataRoot,
      defaultRootPath: root.canonicalPath,
      nodePath: process.execPath,
      cliPath,
    } as const;
    await manageRuntimeHostService({ ...common, action: 'install' }, backend, {
      waitForReady: async () => undefined,
    });
    const binding = {
      expectedTarget: {
        serviceId: resolveRuntimeHostManagedServiceId(clientDataRoot),
        rootPath: root.canonicalPath,
        rootId: root.rootId,
      },
    } as const;

    await manageRuntimeHostService({ ...common, ...binding, action: 'start' }, backend, {
      waitForReady: async () => undefined,
    });
    assert.equal(starts, 1);
    await assert.rejects(
      manageRuntimeHostService(
        {
          ...common,
          ...binding,
          expectedTarget: {
            ...binding.expectedTarget,
            rootId: 'f'.repeat(64),
          },
          action: 'start',
        },
        backend,
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'target_mismatch',
    );
    assert.equal(starts, 1);

    await rm(resolveRuntimeHostManagedServiceConfigPath(clientDataRoot));
    const repaired = await manageRuntimeHostService(
      {
        ...common,
        ...binding,
        defaultRootPath: join(base, 'different-default'),
        action: 'install',
      },
      backend,
      { waitForReady: async () => undefined },
    );
    assert.equal(repaired.service.config?.rootPath, root.canonicalPath);
  });

  it('stops partial deployment state when start or restart fails', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-start-failure-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const cliPath = join(base, 'cli.js');
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
    let stops = 0;
    let stopFails = false;
    const failedAction = async () => {
      throw new Error('scheduler start failed');
    };
    const backend: RuntimeHostServiceBackend = {
      ...createReadyBackend(),
      start: failedAction,
      restart: failedAction,
      stop: async () => {
        stops += 1;
        if (stopFails) throw new Error('partial deployment stop failed');
      },
    };
    const common = {
      clientDataRoot: join(base, 'config'),
      defaultRootPath: join(base, 'state'),
      nodePath: process.execPath,
      cliPath,
    } as const;
    await manageRuntimeHostService({ ...common, action: 'install' }, backend, {
      waitForReady: async () => undefined,
    });

    await assert.rejects(
      manageRuntimeHostService({ ...common, action: 'start' }, backend),
      /scheduler start failed/u,
    );
    assert.equal(stops, 1);

    stopFails = true;
    await assert.rejects(
      manageRuntimeHostService({ ...common, action: 'restart' }, backend),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError &&
        error.code === 'service_manager_operation_failed' &&
        error.cause instanceof AggregateError &&
        error.cause.errors.length === 2,
    );
    assert.equal(stops, 2);
  });

  it('retires the exact managed Host only after active work is authorized', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-retirement-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const clientDataRoot = join(base, 'config');
    const root = await resolveStorageRoot({ path: join(base, 'state'), kind: 'interactive' });
    const cliPath = join(base, 'cli.js');
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
    let serviceState: 'running' | 'starting' | 'stopped' = 'running';
    let startingPid: number | null = null;
    let stops = 0;
    let observedStartingFence = false;
    let publishPidlessSuccessor = false;
    const backend: RuntimeHostServiceBackend = {
      ...createReadyBackend(),
      status: async () => ({
        manager: 'systemd_user',
        installed: true,
        enabled: true,
        active: serviceState === 'running',
        state: serviceState,
        pid: serviceState === 'running' ? 42 : serviceState === 'starting' ? startingPid : null,
        lastExitCode: 0,
      }),
      retire: async () => {
        stops += 1;
        if (serviceState === 'starting' && startingPid === null) {
          const contender = await tryAcquireInteractiveRootOwner(root);
          observedStartingFence = contender === undefined;
          await contender?.close();
        }
        serviceState = 'stopped';
      },
    };
    const common = {
      clientDataRoot,
      defaultRootPath: root.canonicalPath,
      nodePath: process.execPath,
      cliPath,
    } as const;
    await manageRuntimeHostService({ ...common, action: 'install' }, backend, {
      waitForReady: async () => undefined,
    });
    const expectedTarget = {
      serviceId: resolveRuntimeHostManagedServiceId(clientDataRoot),
      rootPath: root.canonicalPath,
      rootId: root.rootId,
    } as const;
    const deps = {
      prepareRetirement: async (
        _config: RuntimeHostManagedServiceConfig,
        expectedPid: number,
        allow: boolean,
      ) => {
        assert.equal(expectedPid, 42);
        if (publishPidlessSuccessor) {
          serviceState = 'starting';
          startingPid = null;
        }
        return allow
          ? ({ kind: 'prepared', hostEpoch: 'host-1', pid: 42 } as const)
          : ({ kind: 'active_tasks' } as const);
      },
    } as const;

    const blocked = await manageRuntimeHostService(
      { ...common, action: 'retire', expectedTarget },
      backend,
      deps,
    );
    assert.deepEqual(blocked.retirement, { kind: 'active_tasks' });
    assert.equal(stops, 0);

    const blockedUninstall = await manageRuntimeHostService(
      {
        ...common,
        action: 'uninstall',
        expectedTarget,
        retainManagedDeployment: true,
      },
      backend,
      deps,
    );
    assert.deepEqual(blockedUninstall.retirement, { kind: 'active_tasks' });
    assert.equal(blockedUninstall.service.installed, true);
    assert.equal(stops, 0);

    const retired = await manageRuntimeHostService(
      {
        ...common,
        action: 'retire',
        expectedTarget,
        allowInterruptActiveTasks: true,
      },
      backend,
      deps,
    );
    assert.deepEqual(retired.retirement, {
      kind: 'retired',
      hostEpoch: 'host-1',
      pid: 42,
    });
    assert.equal(stops, 1);

    const conflictingOwner = await tryAcquireInteractiveRootOwner(root);
    assert.ok(conflictingOwner);
    await assert.rejects(
      manageRuntimeHostService({ ...common, action: 'retire', expectedTarget }, backend, deps),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'retirement_failed',
    );
    await conflictingOwner.close();

    serviceState = 'starting';
    const starting = await manageRuntimeHostService(
      { ...common, action: 'retire', expectedTarget },
      backend,
      deps,
    );
    assert.deepEqual(starting.retirement, { kind: 'stopped' });
    assert.equal(serviceState, 'stopped');
    assert.equal(observedStartingFence, true);

    serviceState = 'starting';
    const competingStarter = await tryAcquireInteractiveRootOwner(root);
    assert.ok(competingStarter);
    const stopsBeforeConflict = stops;
    await assert.rejects(
      manageRuntimeHostService({ ...common, action: 'retire', expectedTarget }, backend, deps),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'retirement_failed',
    );
    assert.equal(stops, stopsBeforeConflict);
    await competingStarter.close();

    serviceState = 'starting';
    startingPid = 42;
    const startingBlocked = await manageRuntimeHostService(
      { ...common, action: 'retire', expectedTarget },
      backend,
      deps,
    );
    assert.deepEqual(startingBlocked.retirement, { kind: 'active_tasks' });
    assert.equal(serviceState, 'starting');

    const startingRetired = await manageRuntimeHostService(
      {
        ...common,
        action: 'retire',
        expectedTarget,
        allowInterruptActiveTasks: true,
      },
      backend,
      deps,
    );
    assert.deepEqual(startingRetired.retirement, {
      kind: 'retired',
      hostEpoch: 'host-1',
      pid: 42,
    });
    assert.equal(serviceState, 'stopped');

    serviceState = 'running';
    publishPidlessSuccessor = true;
    const stopsBeforeSuccessor = stops;
    await assert.rejects(
      manageRuntimeHostService(
        {
          ...common,
          action: 'retire',
          expectedTarget,
          allowInterruptActiveTasks: true,
        },
        backend,
        deps,
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'retirement_failed',
    );
    assert.equal(stops, stopsBeforeSuccessor);
    assert.equal(serviceState, 'starting');
  });

  it('fails closed without stopping a successor that won the State Root', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-retirement-generation-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const clientDataRoot = join(base, 'config');
    const root = await resolveStorageRoot({ path: join(base, 'state'), kind: 'interactive' });
    const cliPath = join(base, 'cli.js');
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
    let serviceState: 'running' | 'stopped' = 'running';
    let servicePid: number | null = 42;
    let stops = 0;
    let successor: Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>;
    const backend: RuntimeHostServiceBackend = {
      ...createReadyBackend(),
      status: async () => ({
        manager: 'systemd_user',
        installed: true,
        enabled: true,
        active: serviceState === 'running',
        state: serviceState,
        pid: serviceState === 'running' ? servicePid : null,
        lastExitCode: 0,
      }),
      retire: async () => {
        stops += 1;
        serviceState = 'stopped';
        servicePid = null;
      },
    };
    const common = {
      clientDataRoot,
      defaultRootPath: root.canonicalPath,
      nodePath: process.execPath,
      cliPath,
    } as const;
    await manageRuntimeHostService({ ...common, action: 'install' }, backend, {
      waitForReady: async () => undefined,
    });
    const expectedTarget = {
      serviceId: resolveRuntimeHostManagedServiceId(clientDataRoot),
      rootPath: root.canonicalPath,
      rootId: root.rootId,
    } as const;
    await assert.rejects(
      manageRuntimeHostService(
        { ...common, action: 'retire', expectedTarget, allowInterruptActiveTasks: true },
        backend,
        {
          prepareRetirement: async (
            _config: RuntimeHostManagedServiceConfig,
            expectedPid: number,
          ) => {
            assert.equal(expectedPid, 42);
            successor = await tryAcquireInteractiveRootOwner(root);
            assert.ok(successor);
            servicePid = 43;
            return { kind: 'prepared', hostEpoch: 'host-a', pid: expectedPid } as const;
          },
        },
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'retirement_failed',
    );
    assert.equal(stops, 0);
    assert.equal(servicePid, 43);
    await successor?.close();
  });

  it('restores the deployed service when the replacement never becomes ready', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-rollback-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const clientDataRoot = join(base, 'config');
    const stateRoot = join(base, 'state');
    const cliPath = join(base, 'cli.js');
    const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
    const unitPath = resolveSystemdUserRuntimeHostServicePath(serviceId, {
      XDG_CONFIG_HOME: base,
    });
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
    const systemd = createFakeSystemd(unitPath);
    const backend = () =>
      createSystemdUserRuntimeHostService(serviceId, {
        serviceConfigPath: resolveRuntimeHostManagedServiceConfigPath(clientDataRoot),
        env: { XDG_CONFIG_HOME: base },
        homeDir: base,
        uid: 1000,
        runSystemctl: systemd.run,
        runLoginctl: async () => success('yes\n'),
      });
    const input = {
      action: 'install' as const,
      clientDataRoot,
      defaultRootPath: stateRoot,
      nodePath: process.execPath,
      cliPath,
    };

    const first = await manageRuntimeHostService({ ...input, websocketPort: 41_001 }, backend(), {
      waitForReady: async () => undefined,
    });
    assert.equal(first.service.config?.websocket.port, 41_001);

    const updateCallsStart = systemd.calls.length;
    await assert.rejects(
      manageRuntimeHostService({ ...input, websocketPort: 41_002 }, backend(), {
        waitForReady: async () => {
          throw new RuntimeHostServiceManagerError(
            'service_manager_operation_failed',
            'candidate failed readiness',
          );
        },
      }),
      /candidate failed readiness/u,
    );
    assert.deepEqual(systemd.calls.slice(updateCallsStart).slice(-2), [
      ['reset-failed', basename(unitPath)],
      ['restart', basename(unitPath)],
    ]);
    const status = await manageRuntimeHostService({ ...input, action: 'status' }, backend());
    assert.equal(status.service.config?.websocket.port, 41_001);
    assert.match(await readFile(unitPath, 'utf8'), /--managed-service-config/u);
    assert.equal(status.service.active, true);

    systemd.failNext('restart');
    await assert.rejects(
      manageRuntimeHostService({ ...input, websocketPort: 41_003 }, backend(), {
        waitForReady: async () => undefined,
      }),
      /Starting the Runtime Host service failed/u,
    );
    assert.match(await readFile(unitPath, 'utf8'), /--managed-service-config/u);

    const replacementBackend = backend();
    await replacementBackend.stop();
    systemd.failNext('restart');
    assert.ok(first.service.config);
    const replacementConfig = {
      ...first.service.config,
      websocket: { ...first.service.config.websocket, port: 41_004 },
    };
    await assert.rejects(
      replacementBackend.replace(replacementConfig),
      /Starting the Runtime Host service failed/u,
    );
    assert.match(await readFile(unitPath, 'utf8'), /--managed-service-config/u);
    assert.equal((await replacementBackend.status()).state, 'stopped');
  });

  it('distinguishes backend replacement failure from unknown target readiness', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-update-failure-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const clientDataRoot = join(base, 'config');
    const root = await resolveStorageRoot({ path: join(base, 'state'), kind: 'interactive' });
    const previousCli = join(base, 'previous', 'dist', 'cli.js');
    const targetCli = join(base, 'target', 'dist', 'cli.js');
    await mkdir(dirname(previousCli), { recursive: true });
    await mkdir(dirname(targetCli), { recursive: true });
    await writeFile(previousCli, '#!/usr/bin/env node\n', 'utf8');
    await writeFile(targetCli, '#!/usr/bin/env node\n', 'utf8');
    let state: 'running' | 'stopped' = 'running';
    let replaceCalls = 0;
    let replaceFails = true;
    let stopFails = false;
    const backend: RuntimeHostServiceBackend = {
      ...createReadyBackend(),
      status: async () => ({
        manager: 'systemd_user',
        installed: true,
        enabled: true,
        active: state === 'running',
        state,
        pid: state === 'running' ? 42 : null,
        lastExitCode: 0,
      }),
      replace: async () => {
        replaceCalls += 1;
        if (replaceFails) throw new Error('replacement was not committed');
        state = 'running';
      },
      retire: async () => {
        if (stopFails) throw new Error('replacement could not be stopped');
        state = 'stopped';
      },
    };
    const common = {
      clientDataRoot,
      defaultRootPath: root.canonicalPath,
      nodePath: process.execPath,
    } as const;
    await manageRuntimeHostService(
      { ...common, action: 'install', cliPath: previousCli },
      backend,
      { waitForReady: async () => undefined },
    );
    state = 'stopped';
    const expectedTarget = {
      serviceId: resolveRuntimeHostManagedServiceId(clientDataRoot),
      rootPath: root.canonicalPath,
      rootId: root.rootId,
    };
    await assert.rejects(
      replaceRuntimeHostManagedService({ ...common, cliPath: targetCli, expectedTarget }, backend),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'update_incomplete',
    );
    assert.equal(replaceCalls, 1);
    const restored = JSON.parse(
      await readFile(resolveRuntimeHostManagedServiceConfigPath(clientDataRoot), 'utf8'),
    ) as RuntimeHostManagedServiceConfig;
    assert.equal(restored.launch.cliPath, await realpath(previousCli));

    replaceFails = false;
    await assert.rejects(
      replaceRuntimeHostManagedService({ ...common, cliPath: targetCli, expectedTarget }, backend, {
        waitForReady: async () => Promise.reject(new Error('target readiness is unknown')),
      }),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'update_incomplete',
    );
    assert.equal(replaceCalls, 2);
    const retained = JSON.parse(
      await readFile(resolveRuntimeHostManagedServiceConfigPath(clientDataRoot), 'utf8'),
    ) as RuntimeHostManagedServiceConfig;
    assert.equal(retained.launch.cliPath, await realpath(targetCli));

    stopFails = true;
    await assert.rejects(
      replaceRuntimeHostManagedService({ ...common, cliPath: targetCli, expectedTarget }, backend, {
        waitForReady: async () => Promise.reject(new Error('target readiness is unknown')),
      }),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError &&
        error.code === 'update_incomplete' &&
        error.cause instanceof AggregateError &&
        /could not be stopped/u.test(error.message),
    );
    assert.equal(state, 'running');
  });

  it('updates through the current operator and preserves exact update outcomes', async () => {
    const clientDataRoot = '/home/ada/.config/maka';
    const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
    const deploymentRoot = '/home/ada/.local/share/Maka/runtime-host-services/service';
    const expectedTarget = {
      serviceId,
      rootPath: '/home/ada/.local/share/Maka/workspaces/default',
      rootId: 'a'.repeat(64),
    };
    const order: string[] = [];
    const service = (
      version: string,
      state: 'running' | 'stopped',
      cliPath = join(deploymentRoot, 'versions', version, 'dist', 'cli.js'),
    ) =>
      ({
        schemaVersion: 1,
        action: 'status',
        service: {
          manager: 'systemd_user',
          installed: true,
          enabled: true,
          active: state === 'running',
          state,
          pid: state === 'running' ? 42 : null,
          lastExitCode: 0,
          installedVersion: version,
          config: {
            schemaVersion: 1,
            managedDeploymentRoot: deploymentRoot,
            rootPath: expectedTarget.rootPath,
            projectDirectoryRoots: [],
            websocket: { host: '127.0.0.1', port: 7400, path: '/runtime-host' },
            launch: {
              nodePath: process.execPath,
              cliPath,
            },
          },
        },
      }) satisfies RuntimeHostManagedServiceResult;
    let statusReads = 0;
    let observedVersion = '1.0.0';
    let observedState: 'running' | 'stopped' = 'running';
    let observedCliPath: string | undefined;
    let readyFailure = false;
    let operatorSupportsProcessLifetimeLock = false;
    let legacyLeaseCalls = 0;
    let operatorStatusFailure = false;
    let operatorFailure: Extract<RuntimeHostServiceManagementFrame, { kind: 'error' }> | undefined;
    let replacementPreconditionFailure = false;
    let replaceFailure = false;
    let cleanupFailure = false;
    let expectAllowInterruptActiveTasks = true;
    let insideLifecycle = false;
    let output = '';
    const options = {
      json: false,
      framed: true,
      clientDataRoot,
      defaultRootPath: expectedTarget.rootPath,
      sourcePackageRoot: '/target-package',
      version: '2.0.0',
      expectedTarget,
      allowInterruptActiveTasks: true,
    } as const;
    const deployment = (version: string, cliPath: string) => ({
      version,
      root: deploymentRoot,
      cliPath,
      operatorPath: join(deploymentRoot, 'operator'),
      activate: async () => {
        assert.equal(insideLifecycle, true);
        order.push('activate');
        operatorSupportsProcessLifetimeLock = true;
      },
      cleanup: async () => {
        order.push('cleanup');
        if (cleanupFailure) throw new Error('Injected package cleanup failure');
      },
      rollback: async () => {
        order.push('rollback');
      },
    });
    const overrides = {
      createBackend: () => ({
        ...createUnusedBackend(),
        verifyReplacementPreconditions: async () => {
          if (replacementPreconditionFailure) {
            throw new RuntimeHostServiceManagerError(
              'target_mismatch',
              'The update scheduler is not ready for replacement',
            );
          }
        },
        retire: async () => {
          assert.equal(insideLifecycle, true);
          order.push('force-retire');
        },
      }),
      withLifecycleLock: async <T>(_root: string, operation: () => Promise<T>) => {
        assert.equal(insideLifecycle, false);
        insideLifecycle = true;
        try {
          return await operation();
        } finally {
          insideLifecycle = false;
        }
      },
      withDeploymentLock: async <T>(_root: string, operation: () => Promise<T>) => operation(),
      withLegacyOperatorLeases: async <T>(
        _root: string,
        operation: (fds: readonly number[]) => Promise<T>,
      ) => {
        legacyLeaseCalls += 1;
        return operation([]);
      },
      openDeployment: async (
        input: Parameters<typeof openRuntimeHostManagedPackageDeployment>[0],
      ) => deployment(input.version, input.cliPath),
      prepareDeployment: async (
        input: Parameters<typeof prepareRuntimeHostManagedPackageDeployment>[0],
      ) =>
        deployment(
          input.version,
          resolveRuntimeHostManagedPackageCliPath(
            deploymentRoot,
            input.version,
            input.packageIntegrity,
          ),
        ),
      runOperator: async (
        _operatorPath: string,
        args: readonly string[],
        invocation?: {
          readonly inheritedFds?: readonly number[];
          readonly capabilityRequest?: RuntimeHostOperatorCapability;
        },
      ) => {
        const action = args[0];
        assert.ok(action === 'status' || action === 'retire');
        if (action === 'status') {
          if (operatorStatusFailure) throw new Error('The active operator is unavailable');
          assert.equal(
            invocation?.capabilityRequest,
            RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY,
          );
          return {
            schemaVersion: 1 as const,
            kind: 'result' as const,
            action: 'status' as const,
            service: {
              platform: 'linux',
              arch: 'x64',
              osRelease: 'test',
              state: 'running' as const,
              pid: 42,
              lastExitCode: 0,
              installedVersion: observedVersion,
              stateRoot: expectedTarget.rootPath,
              projectDirectoryRoots: [],
            },
            ...(operatorSupportsProcessLifetimeLock
              ? {
                  operatorCapabilities: [
                    RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY,
                  ] as RuntimeHostOperatorCapability[],
                }
              : {}),
          };
        }
        order.push(action);
        if (action === 'retire') {
          assert.equal(
            args.includes('--allow-interrupt-active-tasks'),
            expectAllowInterruptActiveTasks,
          );
        }
        if (operatorFailure) return operatorFailure;
        return {
          schemaVersion: 1 as const,
          kind: 'result' as const,
          action: 'retire' as const,
          service: {
            platform: 'linux',
            arch: 'x64',
            osRelease: 'test',
            state: 'stopped' as const,
            pid: null,
            lastExitCode: 3,
            installedVersion: '1.0.0',
            stateRoot: expectedTarget.rootPath,
            projectDirectoryRoots: [],
          },
          retirement: { kind: 'retired' as const, hostEpoch: 'host-1', pid: 42 },
        };
      },
      verifyReady: async () => {
        if (readyFailure) throw new Error('Host is active but not ready');
      },
      manage: async (input: Parameters<typeof manageRuntimeHostService>[0]) => {
        if (input.action === 'stop') {
          assert.equal(insideLifecycle, true);
          order.push('stop');
          return service(observedVersion, 'stopped', observedCliPath);
        }
        assert.equal(input.action, 'status');
        statusReads += 1;
        if (statusReads > 1) assert.equal(insideLifecycle, true);
        return service(
          observedVersion,
          statusReads === 1 ? observedState : 'stopped',
          observedCliPath,
        );
      },
      replace: async (input: Parameters<typeof replaceRuntimeHostManagedService>[0]) => {
        assert.equal(insideLifecycle, true);
        order.push('replace');
        if (replaceFailure) {
          throw new RuntimeHostServiceManagerError(
            'update_incomplete',
            'The replacement did not become ready',
          );
        }
        return service('2.0.0', 'running', input.cliPath).service;
      },
      writeOutput: (value: string) => {
        output += value;
      },
    };
    const exitCode = await runManagedRuntimeHostUpdateCli(options, overrides);
    assert.equal(exitCode, 0);
    assert.deepEqual(order, ['retire', 'activate', 'replace', 'cleanup']);
    assert.equal(legacyLeaseCalls, 1);
    const frames = output
      .trim()
      .split('\n')
      .map((line) => decodeRuntimeHostServiceManagementFrame(line));
    const result = frames.at(-1);
    assert.equal(result?.kind, 'result');
    assert.equal(
      result?.kind === 'result' && result.action === 'update' ? result.update.kind : undefined,
      'updated',
    );

    replacementPreconditionFailure = true;
    order.length = 0;
    statusReads = 0;
    output = '';
    assert.equal(await runManagedRuntimeHostUpdateCli(options, overrides), 1);
    assert.deepEqual(order, []);
    const preconditionFailure = decodeRuntimeHostServiceManagementFrame(output.trim());
    assert.equal(
      preconditionFailure?.kind === 'error' ? preconditionFailure.error.code : undefined,
      'target_mismatch',
    );
    replacementPreconditionFailure = false;

    order.length = 0;
    statusReads = 0;
    observedVersion = '2.0.0';
    observedState = 'stopped';
    output = '';
    assert.equal(await runManagedRuntimeHostUpdateCli(options, overrides), 0);
    assert.deepEqual(order, ['activate', 'replace', 'cleanup']);
    const recovery = decodeRuntimeHostServiceManagementFrame(
      output.trim().split('\n').at(-1) ?? '',
    );
    assert.equal(
      recovery?.kind === 'result' && recovery.action === 'update'
        ? recovery.update.kind
        : undefined,
      'repaired',
    );

    order.length = 0;
    statusReads = 0;
    observedState = 'running';
    output = '';
    assert.equal(await runManagedRuntimeHostUpdateCli(options, overrides), 0);
    assert.deepEqual(order, ['cleanup']);

    cleanupFailure = true;
    order.length = 0;
    statusReads = 0;
    output = '';
    assert.equal(
      await runManagedRuntimeHostUpdateCli({ ...options, json: true, framed: false }, overrides),
      1,
    );
    assert.deepEqual(order, ['cleanup']);
    const cleanupRecovery = JSON.parse(output) as RuntimeHostServiceManagementFrame;
    assert.equal(
      cleanupRecovery.kind === 'error' ? cleanupRecovery.error.code : undefined,
      'update_incomplete',
    );
    cleanupFailure = false;

    const localTargetCliPath = join(deploymentRoot, 'versions', '2.0.0', 'dist', 'cli.js');
    const packageIntegrity =
      'sha512-jUKdo/5dbM94KXq+kOZ1d+obhDLAENfI/QWr1PnXWcdu2PqDyLklJBtiVO6HRwoL1l40z1NE9Rq+hLAxCN0Fyg==';
    order.length = 0;
    statusReads = 0;
    output = '';
    assert.equal(
      await runManagedRuntimeHostUpdateCli(
        {
          ...options,
          registrySelection: {
            integrity: packageIntegrity,
            current: { version: '2.0.0', cliPath: localTargetCliPath },
          },
        },
        overrides,
      ),
      0,
    );
    assert.deepEqual(order, ['retire', 'activate', 'replace', 'cleanup']);
    const identityUpdate = decodeRuntimeHostServiceManagementFrame(
      output.trim().split('\n').at(-1) ?? '',
    );
    assert.equal(
      identityUpdate?.kind === 'result' && identityUpdate.action === 'update'
        ? identityUpdate.update.kind
        : undefined,
      'updated',
    );

    order.length = 0;
    statusReads = 0;
    output = '';
    observedCliPath = join(deploymentRoot, 'versions', 'other', 'dist', 'cli.js');
    assert.equal(
      await runManagedRuntimeHostUpdateCli(
        {
          ...options,
          registrySelection: {
            integrity: packageIntegrity,
            current: { version: '2.0.0', cliPath: localTargetCliPath },
          },
        },
        overrides,
      ),
      1,
    );
    assert.deepEqual(order, []);
    const staleIdentity = decodeRuntimeHostServiceManagementFrame(output.trim());
    assert.equal(
      staleIdentity?.kind === 'error' ? staleIdentity.error.code : undefined,
      'target_mismatch',
    );
    observedCliPath = undefined;

    order.length = 0;
    statusReads = 0;
    output = '';
    readyFailure = true;
    assert.equal(await runManagedRuntimeHostUpdateCli(options, overrides), 0);
    assert.deepEqual(order, ['retire', 'activate', 'replace', 'cleanup']);
    assert.equal(legacyLeaseCalls, 1);
    const activeRecovery = decodeRuntimeHostServiceManagementFrame(
      output.trim().split('\n').at(-1) ?? '',
    );
    assert.equal(
      activeRecovery?.kind === 'result' && activeRecovery.action === 'update'
        ? activeRecovery.update.kind
        : undefined,
      'repaired',
    );

    order.length = 0;
    statusReads = 0;
    output = '';
    operatorStatusFailure = true;
    assert.equal(await runManagedRuntimeHostUpdateCli(options, overrides), 0);
    assert.deepEqual(order, ['force-retire', 'activate', 'replace', 'cleanup']);
    operatorStatusFailure = false;

    order.length = 0;
    statusReads = 0;
    output = '';
    operatorFailure = {
      schemaVersion: 1,
      kind: 'error',
      action: 'retire',
      error: { code: 'retirement_failed', message: 'The active Host is not reachable' },
    };
    expectAllowInterruptActiveTasks = false;
    const { allowInterruptActiveTasks: _allowInterruptActiveTasks, ...safeOptions } = options;
    assert.equal(await runManagedRuntimeHostUpdateCli(safeOptions, overrides), 1);
    assert.deepEqual(order, ['retire', 'rollback']);
    const activeTasks = decodeRuntimeHostServiceManagementFrame(
      output.trim().split('\n').at(-1) ?? '',
    );
    assert.equal(
      activeTasks?.kind === 'result' && activeTasks.action === 'update'
        ? activeTasks.update.kind
        : undefined,
      'active_tasks',
    );

    order.length = 0;
    statusReads = 0;
    output = '';
    expectAllowInterruptActiveTasks = true;
    assert.equal(await runManagedRuntimeHostUpdateCli(options, overrides), 0);
    assert.deepEqual(order, ['retire', 'force-retire', 'activate', 'replace', 'cleanup']);
    assert.equal(legacyLeaseCalls, 1);

    statusReads = 0;
    observedVersion = '1.0.0';
    output = '';
    order.length = 0;
    assert.equal(await runManagedRuntimeHostUpdateCli(options, overrides), 1);
    assert.deepEqual(order, ['retire', 'rollback']);
    const retirementFailure = decodeRuntimeHostServiceManagementFrame(
      output.trim().split('\n').at(-1) ?? '',
    );
    assert.equal(retirementFailure?.kind, 'error');
    assert.equal(
      retirementFailure?.kind === 'error' ? retirementFailure.error.code : undefined,
      'retirement_failed',
    );

    statusReads = 0;
    operatorFailure = undefined;
    replaceFailure = true;
    output = '';
    order.length = 0;
    assert.equal(
      await runManagedRuntimeHostUpdateCli(
        {
          ...options,
          json: true,
          framed: false,
          registrySelection: {
            integrity: packageIntegrity,
            current: {
              version: '1.0.0',
              cliPath: join(deploymentRoot, 'versions', '1.0.0', 'dist', 'cli.js'),
            },
          },
        },
        overrides,
      ),
      1,
    );
    assert.deepEqual(order, ['retire', 'activate', 'replace']);
    const incomplete = JSON.parse(output) as RuntimeHostServiceManagementFrame;
    assert.equal(
      incomplete.kind === 'error' ? incomplete.error.code : undefined,
      'update_incomplete',
    );

    statusReads = 0;
    observedVersion = '3.0.0';
    replaceFailure = false;
    output = '';
    order.length = 0;
    assert.equal(
      await runManagedRuntimeHostUpdateCli(
        {
          ...options,
          registrySelection: {
            integrity: packageIntegrity,
            current: {
              version: '1.0.0',
              cliPath: join(deploymentRoot, 'versions', '1.0.0', 'dist', 'cli.js'),
            },
          },
        },
        overrides,
      ),
      1,
    );
    assert.deepEqual(order, []);
    const staleCandidate = decodeRuntimeHostServiceManagementFrame(output.trim());
    assert.equal(
      staleCandidate?.kind === 'error' ? staleCandidate.error.code : undefined,
      'target_mismatch',
    );
  });

  it('rejects invalid Project roots and temporary npx launch paths before deployment', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-input-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const cliPath = join(base, 'cli.js');
    const fileRoot = join(base, 'not-a-directory');
    const directoryRoot = join(base, 'directory');
    const npxCliPath = join(base, '.npm', '_npx', 'temporary', 'cli.js');
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
    await mkdir(join(base, '.npm', '_npx', 'temporary'), { recursive: true });
    await writeFile(npxCliPath, '#!/usr/bin/env node\n', 'utf8');
    await writeFile(fileRoot, '', 'utf8');
    await mkdir(directoryRoot);
    const input = {
      action: 'install' as const,
      clientDataRoot: join(base, 'config'),
      defaultRootPath: join(base, 'state'),
      nodePath: process.execPath,
      cliPath,
    };
    const backend = createPreparedUnusedBackend();

    await assert.rejects(
      manageRuntimeHostService(
        { ...input, projectDirectoryRoots: [{ label: 'file', path: fileRoot }] },
        backend,
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'invalid_config',
    );
    await assert.rejects(
      manageRuntimeHostService(
        {
          ...input,
          projectDirectoryRoots: [
            { label: 'first', path: directoryRoot },
            { label: 'second', path: directoryRoot },
          ],
        },
        backend,
      ),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'invalid_config',
    );
    await assert.rejects(
      manageRuntimeHostService({ ...input, cliPath: npxCliPath }, backend, { homeDir: base }),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError && error.code === 'invalid_launch',
    );

    const installedFromNpx = await manageRuntimeHostService(input, createReadyBackend(), {
      environment: {
        npm_command: 'exec',
        npm_lifecycle_event: 'npx',
        npm_config_cache: join(base, '.npm'),
      },
      homeDir: base,
      waitForReady: async () => undefined,
    });
    assert.equal(installedFromNpx.service.config?.launch.cliPath, await realpath(cliPath));
  });

  it('reports an unavailable systemd manager instead of not installed', async () => {
    const backend = createSystemdUserRuntimeHostService(
      resolveRuntimeHostManagedServiceId('/config/Maka'),
      {
        serviceConfigPath: '/config/Maka/runtime-host-service.json',
        runSystemctl: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'Failed to connect to bus',
        }),
      },
    );
    await assert.rejects(
      backend.status(),
      (error: unknown) =>
        error instanceof RuntimeHostServiceManagerError &&
        error.code === 'service_manager_operation_failed',
    );
  });

  it('serializes status behind an in-flight deployment', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-lock-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const cliPath = join(base, 'cli.js');
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    let markInstallStarted!: () => void;
    const installStarted = new Promise<void>((resolve) => {
      markInstallStarted = resolve;
    });
    const backend: RuntimeHostServiceBackend = {
      ...createReadyBackend(),
      stageDeployment: async () => {
        return {
          apply: async () => markInstallStarted(),
          rollback: async () => undefined,
        };
      },
    };
    const input = {
      clientDataRoot: join(base, 'config'),
      defaultRootPath: join(base, 'state'),
      nodePath: process.execPath,
      cliPath,
    } as const;
    const installing = manageRuntimeHostService({ ...input, action: 'install' }, backend, {
      waitForReady: () => ready,
    });
    await installStarted;
    let statusSettled = false;
    const status = manageRuntimeHostService({ ...input, action: 'status' }, backend).finally(() => {
      statusSettled = true;
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    assert.equal(statusSettled, false);

    releaseReady();
    await installing;
    assert.notEqual((await status).service.config, null);
  });
});

function legacySystemdUnitFixture(config: RuntimeHostManagedServiceConfig): string {
  const args = [
    config.launch.nodePath,
    config.launch.cliPath,
    'runtime-host',
    'serve',
    '--root',
    config.rootPath,
    ...config.projectDirectoryRoots.flatMap(({ label, path }) => [
      '--project-root',
      `${label}=${path}`,
    ]),
    '--websocket-host',
    config.websocket.host,
    '--websocket-port',
    String(config.websocket.port),
    '--websocket-path',
    config.websocket.path,
    '--json',
  ];
  const quote = (value: string) =>
    `"${value
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('%', '%%')
      .replaceAll('$', '$$')}"`;
  return [
    '[Unit]',
    'Description=Maka Runtime Host',
    'After=network.target',
    'StartLimitIntervalSec=60s',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${args.map(quote).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=2s',
    'KillMode=mixed',
    'TimeoutStopSec=45s',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function createFakeSystemd(unitPath: string): {
  readonly failNext: (command: string) => void;
  readonly activateUnitWhenStopping: (triggerUnit: string, unitToActivate: string) => void;
  readonly setDropInPaths: (paths: readonly string[]) => void;
  readonly setUnitDropInPaths: (unitName: string, paths: readonly string[]) => void;
  readonly calls: readonly (readonly string[])[];
  readonly run: (args: readonly string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
} {
  const states = new Map<string, { enabled: boolean; active: boolean }>();
  let failureCommand: string | undefined;
  const dropInPaths = new Map<string, readonly string[]>();
  let stopActivation: { triggerUnit: string; unitToActivate: string } | undefined;
  const calls: string[][] = [];
  return {
    calls,
    failNext: (command) => {
      failureCommand = command;
    },
    activateUnitWhenStopping: (triggerUnit, unitToActivate) => {
      stopActivation = { triggerUnit, unitToActivate };
    },
    setDropInPaths: (paths) => {
      dropInPaths.set(basename(unitPath), paths);
    },
    setUnitDropInPaths: (unitName, paths) => {
      dropInPaths.set(unitName, paths);
    },
    run: async (args) => {
      calls.push([...args]);
      const unitName = args[1];
      const unitState = unitName
        ? (states.get(unitName) ?? { enabled: false, active: false })
        : undefined;
      if (unitName && unitState) states.set(unitName, unitState);
      if (args[0] === failureCommand) {
        failureCommand = undefined;
        return { exitCode: 1, stdout: '', stderr: `${args[0]} failed` };
      }
      if (args[0] === 'show-environment') return success('PATH=/usr/bin\n');
      if (args[0] === 'daemon-reload') return success();
      if (args[0] === 'enable') {
        assert.ok(unitState);
        unitState.enabled = true;
        return success();
      }
      if (args[0] === 'disable') {
        assert.ok(unitState);
        unitState.enabled = false;
        return success();
      }
      if (args[0] === 'start' || args[0] === 'restart') {
        assert.ok(unitState);
        unitState.active = true;
        return success();
      }
      if (args[0] === 'stop') {
        const targets = args.slice(1);
        if (stopActivation && targets.includes(stopActivation.triggerUnit)) {
          const activated = states.get(stopActivation.unitToActivate) ?? {
            enabled: false,
            active: false,
          };
          activated.active = true;
          states.set(stopActivation.unitToActivate, activated);
          stopActivation = undefined;
        }
        for (const target of targets) {
          const targetState = states.get(target) ?? { enabled: false, active: false };
          targetState.active = false;
          states.set(target, targetState);
        }
        return success();
      }
      if (args[0] === 'reset-failed') return success();
      if (args[0] === 'show') {
        assert.ok(unitName && unitState);
        const path = join(dirname(unitPath), unitName);
        const loaded = await access(path).then(
          () => true,
          () => false,
        );
        const isMainService = unitName === basename(unitPath);
        return {
          exitCode: loaded ? 0 : 4,
          stdout: [
            `LoadState=${loaded ? 'loaded' : 'not-found'}`,
            `ActiveState=${unitState.active ? 'active' : 'inactive'}`,
            `SubState=${unitState.active ? 'running' : 'dead'}`,
            `UnitFileState=${unitState.enabled ? 'enabled' : 'disabled'}`,
            `FragmentPath=${loaded ? path : ''}`,
            'NeedDaemonReload=no',
            `DropInPaths=${dropInPaths.get(unitName)?.join(' ') ?? ''}`,
            `MainPID=${unitState.active && isMainService ? '4242' : '0'}`,
            'ExecMainStatus=0',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      throw new Error(`Unexpected systemctl call: ${args.join(' ')}`);
    },
  };
}

function createUnusedBackend(): RuntimeHostServiceBackend {
  const unexpected = async (): Promise<never> => {
    throw new Error('Backend should not be used by this test');
  };
  return {
    preflightDeployment: unexpected,
    stageDeployment: unexpected,
    replace: unexpected,
    verifyReplacementPreconditions: unexpected,
    verifyDeployment: unexpected,
    status: unexpected,
    start: unexpected,
    stop: unexpected,
    restart: unexpected,
    retire: unexpected,
    logs: unexpected,
    uninstall: unexpected,
  };
}

function createPreparedUnusedBackend(): RuntimeHostServiceBackend {
  return {
    ...createUnusedBackend(),
    preflightDeployment: async () => undefined,
  };
}

function createReadyBackend(): RuntimeHostServiceBackend {
  const status = async () => ({
    manager: 'systemd_user' as const,
    installed: true,
    enabled: true,
    active: true,
    state: 'running' as const,
    pid: 42,
    lastExitCode: 0,
  });
  return {
    preflightDeployment: async () => undefined,
    stageDeployment: async () => ({
      apply: async () => undefined,
      rollback: async () => undefined,
    }),
    replace: async () => undefined,
    verifyReplacementPreconditions: async () => undefined,
    verifyDeployment: async () => undefined,
    status,
    start: async () => undefined,
    stop: async () => undefined,
    restart: async () => undefined,
    retire: async () => undefined,
    logs: async () => '',
    uninstall: async () => undefined,
  };
}

async function applyStagedDeployment(
  backend: RuntimeHostServiceBackend,
  config: RuntimeHostManagedServiceConfig,
  options?: { readonly activate?: boolean },
): Promise<void> {
  const deployment = await backend.stageDeployment();
  await deployment.apply(config, options?.activate ?? true);
}

function success(stdout = ''): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout, stderr: '' };
}
