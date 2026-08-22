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
import { decodeRuntimeHostServiceManagementFrame } from '@maka/runtime-host/operator';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import {
  removeRuntimeHostManagedDeployment,
  resolveRuntimeHostManagedDeploymentRoot,
} from '../runtime-host-managed-deployment.js';
import { runManagedRuntimeHostServiceCli } from '../runtime-host-service-management-command.js';
import {
  manageRuntimeHostService,
  resolveRuntimeHostManagedServiceConfigPath,
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceConfig,
  type RuntimeHostServiceBackend,
} from '../runtime-host-service-manager.js';
import {
  createSystemdUserRuntimeHostService,
  renderSystemdUnit,
  resolveSystemdUserRuntimeHostServicePath,
} from '../runtime-host-systemd-service.js';

describe('managed Runtime Host service', () => {
  it('parses the bounded Linux service command surface', () => {
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
    assert.deepEqual(parseRuntimeHostCommand(['service', 'status', '--framed']), {
      kind: 'runtime-host-service-manage',
      action: 'status',
      json: false,
      framed: true,
    });
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
    assert.deepEqual(parseRuntimeHostCommand(['service', 'uninstall', '--json']), {
      kind: 'runtime-host-service-manage',
      action: 'uninstall',
      json: true,
    });
    assert.deepEqual(
      parseRuntimeHostCommand(['service', 'uninstall', '--framed', '--retain-managed-deployment']),
      {
        kind: 'runtime-host-service-manage',
        action: 'uninstall',
        json: false,
        framed: true,
        retainManagedDeployment: true,
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
        '--defer-pairing-commit',
        '--json',
      ]),
      {
        kind: 'runtime-host-setup',
        json: true,
        principalId: 'desktop.client-1',
        preset: 'desktop-client',
        deferPairingCommit: true,
      },
    );
  });

  it('installs, reports, and cleanly uninstalls while retaining the State Root', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const homeDir = join(base, 'home');
    const clientDataRoot = join(base, 'config', 'Maka');
    const rootPath = join(base, 'state root');
    const projectPath = join(base, 'projects');
    await writeFile(join(base, 'placeholder'), '', 'utf8');
    await mkdir(projectPath, { recursive: true });
    const env = { XDG_CONFIG_HOME: join(base, 'xdg-config') };
    const configPath = resolveRuntimeHostManagedServiceConfigPath(clientDataRoot);
    const serviceId = resolveRuntimeHostManagedServiceId(clientDataRoot);
    const deploymentRoot = resolveRuntimeHostManagedDeploymentRoot(serviceId, {
      env: { XDG_DATA_HOME: join(base, 'xdg-data') },
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
    );
    assert.equal(retained.service.installed, false);
    await access(deploymentRoot);

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
    await access(deploymentRoot);

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
    await assert.rejects(access(deploymentRoot));

    const repeated = await manageRuntimeHostService({ ...common, action: 'uninstall' }, backend());
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
        backend: createSystemdUserRuntimeHostService(serviceId, {
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
    await manageRuntimeHostService(
      { ...input(developmentRoot), action: 'install' },
      development.backend,
      ready,
    );
    await manageRuntimeHostService(
      { ...input(developmentRoot), action: 'uninstall' },
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
    const unit = renderSystemdUnit(config);
    assert.match(unit, /"\/srv\/Maka \$\$100%%"/u);
    assert.match(unit, /"Cash\$\$=\/home\/\$\$ada\/My Projects"/u);
    assert.match(unit, /"\/opt\/\$\$Node 24\/bin\/node"/u);
    assert.match(unit, /"\/opt\/Maka\/\$\$current\/cli\.js"/u);
    assert.match(unit, /^Restart=always$/mu);
    assert.match(unit, /^StartLimitIntervalSec=60s$/mu);
    assert.match(unit, /^StartLimitBurst=5$/mu);
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

  it('projects a framed service summary without launch configuration', async () => {
    let output = '';
    const exitCode = await runManagedRuntimeHostServiceCli(
      {
        action: 'status',
        json: false,
        framed: true,
        clientDataRoot: '/config/Maka',
        defaultRootPath: '/config/Maka/workspaces/default',
        nodePath: '/usr/bin/node',
        cliPath: '/opt/maka/cli.js',
      },
      {
        manage: async () => ({
          schemaVersion: 1,
          action: 'status',
          service: {
            manager: 'systemd_user',
            installed: true,
            enabled: true,
            active: true,
            state: 'running',
            pid: 42,
            lastExitCode: 0,
            installedVersion: '1.2.3',
            config: {
              schemaVersion: 1,
              rootPath: '/srv/maka',
              projectDirectoryRoots: [{ label: 'Home', path: '/home/ada' }],
              websocket: { host: '127.0.0.1', port: 7443, path: '/runtime-host' },
              launch: { nodePath: '/secret/node', cliPath: '/secret/cli.js' },
            },
          },
        }),
        createBackend: createUnusedBackend,
        writeOutput: (value) => {
          output += value;
        },
      },
    );

    assert.equal(exitCode, 0);
    const frame = decodeRuntimeHostServiceManagementFrame(output);
    assert.equal(frame?.kind, 'result');
    if (frame?.kind !== 'result') assert.fail('Expected a service result frame');
    assert.equal(frame.service.installedVersion, '1.2.3');
    assert.equal(frame.service.stateRoot, '/srv/maka');
    assert.doesNotMatch(JSON.stringify(frame), /secret/u);
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
    assert.match(await readFile(unitPath, 'utf8'), /--websocket-port" "41001"/u);
    assert.equal(status.service.active, true);

    systemd.failNext('restart');
    await assert.rejects(
      manageRuntimeHostService({ ...input, websocketPort: 41_003 }, backend(), {
        waitForReady: async () => undefined,
      }),
      /Starting the Runtime Host service failed/u,
    );
    assert.match(await readFile(unitPath, 'utf8'), /--websocket-port" "41001"/u);
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
      install: async () => {
        markInstallStarted();
        return { rollback: async () => undefined };
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

function createFakeSystemd(unitPath: string): {
  readonly failNext: (command: string) => void;
  readonly calls: readonly (readonly string[])[];
  readonly run: (args: readonly string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
} {
  let loaded = false;
  let enabled = false;
  let active = false;
  let failureCommand: string | undefined;
  const calls: string[][] = [];
  return {
    calls,
    failNext: (command) => {
      failureCommand = command;
    },
    run: async (args) => {
      calls.push([...args]);
      if (
        ['show', 'enable', 'disable', 'start', 'restart', 'stop', 'reset-failed'].includes(
          args[0] ?? '',
        )
      ) {
        assert.equal(args[1], basename(unitPath));
      }
      if (args[0] === failureCommand) {
        failureCommand = undefined;
        return { exitCode: 1, stdout: '', stderr: `${args[0]} failed` };
      }
      if (args[0] === 'show-environment') return success('PATH=/usr/bin\n');
      if (args[0] === 'daemon-reload') {
        loaded = await access(unitPath).then(
          () => true,
          () => false,
        );
        return success();
      }
      if (args[0] === 'enable') {
        enabled = true;
        return success();
      }
      if (args[0] === 'disable') {
        enabled = false;
        return success();
      }
      if (args[0] === 'start' || args[0] === 'restart') {
        active = true;
        loaded = true;
        return success();
      }
      if (args[0] === 'stop') {
        active = false;
        return success();
      }
      if (args[0] === 'reset-failed') return success();
      if (args[0] === 'show') {
        return {
          exitCode: loaded ? 0 : 4,
          stdout: [
            `LoadState=${loaded ? 'loaded' : 'not-found'}`,
            `ActiveState=${active ? 'active' : 'inactive'}`,
            `SubState=${active ? 'running' : 'dead'}`,
            `UnitFileState=${enabled ? 'enabled' : 'disabled'}`,
            `MainPID=${active ? '4242' : '0'}`,
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
    preflightInstall: unexpected,
    install: unexpected,
    status: unexpected,
    start: unexpected,
    stop: unexpected,
    restart: unexpected,
    logs: unexpected,
    uninstall: unexpected,
  };
}

function createPreparedUnusedBackend(): RuntimeHostServiceBackend {
  return {
    ...createUnusedBackend(),
    preflightInstall: async () => undefined,
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
    preflightInstall: async () => undefined,
    install: async () => ({ rollback: async () => undefined }),
    status,
    start: async () => undefined,
    stop: async () => undefined,
    restart: async () => undefined,
    logs: async () => '',
    uninstall: async () => undefined,
  };
}

function success(stdout = ''): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout, stderr: '' };
}
