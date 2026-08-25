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
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createLaunchAgentRuntimeHostUpdateScheduler,
  renderLaunchAgentRuntimeHostUpdateSchedulerPlist,
  resolveLaunchAgentRuntimeHostUpdateSchedulerPaths,
} from '../runtime-host-launch-agent-update-scheduler.js';
import {
  createSystemdUserRuntimeHostUpdateScheduler,
  renderSystemdRuntimeHostUpdateService,
  renderSystemdRuntimeHostUpdateTimer,
  resolveSystemdUserRuntimeHostUpdateSchedulerPaths,
} from '../runtime-host-systemd-update-scheduler.js';
import {
  isRuntimeHostScheduledUpdateDue,
  runtimeHostUpdateSchedule,
  runtimeHostUpdateSchedulerArguments,
  withRuntimeHostUpdateScheduler,
  type RuntimeHostUpdateSchedulerBackend,
} from '../runtime-host-update-scheduler.js';
import type {
  RuntimeHostManagedServiceConfig,
  RuntimeHostServiceBackend,
} from '../runtime-host-service-manager.js';

const SERVICE_ID = 'aa'.repeat(32);
const UID = 501;

test('derives one hourly tick, policy phase, and stable operator command', () => {
  const config = fixtureConfig('/srv/maka/runtime-host');
  assert.deepEqual(runtimeHostUpdateSchedule(SERVICE_ID), { minute: 50 });
  assert.equal(isRuntimeHostScheduledUpdateDue(SERVICE_ID, 4, 2 * 60 * 60 * 1_000), true);
  assert.equal(isRuntimeHostScheduledUpdateDue(SERVICE_ID, 4, 3 * 60 * 60 * 1_000), false);
  assert.deepEqual(runtimeHostUpdateSchedulerArguments(config), [
    '/srv/maka/runtime-host/operator',
    'reconcile-update',
    '--scheduled',
    '--json',
  ]);
  assert.equal(
    runtimeHostUpdateSchedulerArguments({
      ...config,
      managedDeploymentRoot: undefined,
    }),
    null,
  );
});

test('installs, verifies, logs, and removes the systemd user update timer', async () => {
  await withFixture(async ({ homeDir, config, operatorPath }) => {
    const systemctl = fakeSystemctl();
    const backend = createSystemdUserRuntimeHostUpdateScheduler(SERVICE_ID, {
      homeDir,
      env: {},
      runSystemctl: systemctl.run,
      runJournalctl: async () => ({
        exitCode: 0,
        stdout: 'scheduler result\n',
        stderr: '',
      }),
    });
    const paths = resolveSystemdUserRuntimeHostUpdateSchedulerPaths(SERVICE_ID, {}, homeDir);

    await rm(operatorPath);
    const deployment = await backend.install(config);
    await backend.verifyDeployment(config);
    await writeOperator(operatorPath);
    assert.equal(
      await readFile(paths.servicePath, 'utf8'),
      renderSystemdRuntimeHostUpdateService([
        join(config.managedDeploymentRoot!, 'operator'),
        'reconcile-update',
        '--scheduled',
        '--json',
      ]),
    );
    assert.equal(
      await readFile(paths.timerPath, 'utf8'),
      renderSystemdRuntimeHostUpdateTimer(SERVICE_ID),
    );
    assert.equal(await backend.logs(), 'scheduler result\n');
    assert.equal(systemctl.enabled, true);
    assert.equal(systemctl.active, true);

    systemctl.active = false;
    await assert.rejects(backend.verifyDeployment(config), /does not match/u);
    systemctl.active = true;

    await deployment.rollback();
    assert.equal(await fileExists(paths.servicePath), false);
    assert.equal(await fileExists(paths.timerPath), false);

    await backend.install(config);
    await backend.uninstall();
    assert.equal(systemctl.enabled, false);
    assert.equal(systemctl.active, false);
    assert.equal(await fileExists(paths.servicePath), false);
    assert.equal(await fileExists(paths.timerPath), false);
  });
});

test('installs, verifies, logs, and removes the periodic LaunchAgent', async () => {
  await withFixture(async ({ homeDir, config }) => {
    const launchctl = fakeLaunchctl(UID);
    const backend = createLaunchAgentRuntimeHostUpdateScheduler(SERVICE_ID, {
      homeDir,
      uid: UID,
      runLaunchctl: launchctl.run,
    });
    const paths = resolveLaunchAgentRuntimeHostUpdateSchedulerPaths(SERVICE_ID, homeDir);

    const deployment = await backend.install(config);
    await backend.verifyDeployment(config);
    assert.equal(
      await readFile(paths.plistPath, 'utf8'),
      renderLaunchAgentRuntimeHostUpdateSchedulerPlist(
        SERVICE_ID,
        [
          join(config.managedDeploymentRoot!, 'operator'),
          'reconcile-update',
          '--scheduled',
          '--json',
        ],
        paths,
      ),
    );
    assert.match(
      await readFile(paths.plistPath, 'utf8'),
      /<key>Minute<\/key>\n    <integer>50<\/integer>/u,
    );
    assert.equal(launchctl.loaded, true);

    await writeFile(paths.stdoutPath, 'disabled\n');
    assert.match(await backend.logs(), /stdout:\ndisabled/u);
    await deployment.rollback();
    assert.equal(launchctl.loaded, false);
    assert.equal(await fileExists(paths.plistPath), false);
    assert.equal(await fileExists(paths.stdoutPath), false);
    assert.equal(await fileExists(paths.stderrPath), false);

    await backend.install(config);
    await backend.uninstall();
    assert.equal(launchctl.loaded, false);
    assert.equal(await fileExists(paths.plistPath), false);
    assert.equal(await fileExists(paths.stdoutPath), false);
    assert.equal(await fileExists(paths.stderrPath), false);
  });
});

test('does not retain a scheduler for a non-managed persistent CLI service', async () => {
  await withFixture(async ({ homeDir, config }) => {
    const systemctl = fakeSystemctl();
    const backend = createSystemdUserRuntimeHostUpdateScheduler(SERVICE_ID, {
      homeDir,
      env: {},
      runSystemctl: systemctl.run,
      runJournalctl: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    const paths = resolveSystemdUserRuntimeHostUpdateSchedulerPaths(SERVICE_ID, {}, homeDir);
    await backend.install(config);
    await backend.install({ ...config, managedDeploymentRoot: undefined });
    assert.equal(systemctl.enabled, false);
    assert.equal(await fileExists(paths.servicePath), false);
    assert.equal(await fileExists(paths.timerPath), false);
  });
});

test('composes the scheduler into service lifecycle without replacing it on version cutover', async () => {
  const order: string[] = [];
  const service = fakeServiceBackend(order);
  const scheduler = fakeSchedulerBackend(order);
  const backend = withRuntimeHostUpdateScheduler(service, scheduler);
  const config = fixtureConfig('/srv/maka/runtime-host');

  const deployment = await backend.install(config);
  await backend.verifyDeployment(config);
  assert.equal(await backend.logs(), 'service log\nupdate scheduler:\nscheduler log');
  await backend.replace(config);
  await backend.uninstall();
  await deployment.rollback();

  assert.deepEqual(order, [
    'service.install',
    'scheduler.install',
    'service.verify',
    'scheduler.verify',
    'service.logs',
    'scheduler.logs',
    'service.replace',
    'scheduler.uninstall',
    'service.uninstall',
    'scheduler.rollback',
    'service.rollback',
  ]);
});

function fixtureConfig(managedDeploymentRoot: string): RuntimeHostManagedServiceConfig {
  return {
    schemaVersion: 1,
    managedDeploymentRoot,
    rootPath: '/srv/maka/state',
    projectDirectoryRoots: [],
    websocket: { host: '127.0.0.1', port: 23456, path: '/runtime-host' },
    launch: { nodePath: process.execPath, cliPath: '/srv/maka/cli.js' },
  };
}

function fakeServiceBackend(order: string[]): RuntimeHostServiceBackend {
  const record = (name: string) => async () => {
    order.push(name);
  };
  return {
    preflightInstall: record('service.preflight'),
    install: async () => {
      order.push('service.install');
      return { rollback: record('service.rollback') };
    },
    replace: record('service.replace'),
    verifyDeployment: record('service.verify'),
    status: async () => ({
      manager: 'systemd_user',
      installed: true,
      enabled: true,
      active: true,
      state: 'running',
      pid: 42,
      lastExitCode: 0,
    }),
    start: record('service.start'),
    stop: record('service.stop'),
    restart: record('service.restart'),
    logs: async () => {
      order.push('service.logs');
      return 'service log';
    },
    uninstall: record('service.uninstall'),
  };
}

function fakeSchedulerBackend(order: string[]): RuntimeHostUpdateSchedulerBackend {
  const record = (name: string) => async () => {
    order.push(name);
  };
  return {
    install: async () => {
      order.push('scheduler.install');
      return { rollback: record('scheduler.rollback') };
    },
    verifyDeployment: record('scheduler.verify'),
    logs: async () => {
      order.push('scheduler.logs');
      return 'scheduler log';
    },
    uninstall: record('scheduler.uninstall'),
  };
}

async function withFixture(
  operation: (fixture: {
    homeDir: string;
    config: RuntimeHostManagedServiceConfig;
    operatorPath: string;
  }) => Promise<void>,
): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'maka-update-scheduler-test-'));
  const deploymentRoot = join(homeDir, 'managed');
  const operatorPath = join(deploymentRoot, 'operator');
  try {
    await mkdir(deploymentRoot, { recursive: true });
    await writeOperator(operatorPath);
    await mkdir(join(homeDir, 'Library', 'LaunchAgents'), { recursive: true });
    await operation({ homeDir, config: fixtureConfig(deploymentRoot), operatorPath });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeOperator(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\n', { mode: 0o700 });
  await chmod(path, 0o700);
}

function fakeSystemctl(): {
  enabled: boolean;
  active: boolean;
  readonly run: (
    args: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
} {
  const fake = {
    enabled: false,
    active: false,
    run: async (args: readonly string[]) => {
      if (args[0] === 'is-enabled') return result(fake.enabled);
      if (args[0] === 'is-active') return result(fake.active);
      if (args[0] === 'enable') {
        fake.enabled = true;
        if (args.includes('--now')) fake.active = true;
      }
      if (args[0] === 'disable') {
        fake.enabled = false;
        if (args.includes('--now')) fake.active = false;
      }
      return result(true);
    },
  };
  return fake;
}

function fakeLaunchctl(uid: number): {
  loaded: boolean;
  readonly run: (
    args: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
} {
  const domain = `gui/${String(uid)}`;
  const target = `${domain}/com.maka.runtime-host-update.${SERVICE_ID}`;
  const fake = {
    loaded: false,
    run: async (args: readonly string[]) => {
      if (args[0] === 'print') {
        assert.equal(args[1], target);
        return result(fake.loaded);
      }
      if (args[0] === 'bootstrap') {
        assert.equal(args[1], domain);
        fake.loaded = true;
        return result(true);
      }
      if (args[0] === 'bootout') {
        assert.equal(args[1], target);
        fake.loaded = false;
        return result(true);
      }
      throw new Error(`Unexpected launchctl arguments: ${args.join(' ')}`);
    },
  };
  return fake;
}

function result(ok: boolean): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return { exitCode: ok ? 0 : 1, stdout: '', stderr: '' };
}

async function fileExists(path: string): Promise<boolean> {
  return readFile(path)
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    });
}
