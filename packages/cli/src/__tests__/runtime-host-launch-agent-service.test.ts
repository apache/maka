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
import { RUNTIME_HOST_SERVICE_LOG_MAX_BYTES } from '@maka/runtime-host/operator';
import {
  createLaunchAgentRuntimeHostLifecycleProvider,
  createLaunchAgentRuntimeHostService,
  renderLaunchAgentPlist,
  renderLaunchAgentUpdatePlist,
  resolveLaunchAgentPath,
  resolveLaunchAgentUpdatePath,
} from '../runtime-host-launch-agent-service.js';
import type {
  RuntimeHostManagedServiceConfig,
  RuntimeHostServiceBackend,
  RuntimeHostServiceDeployment,
} from '../runtime-host-service-manager.js';

const SERVICE_ID = 'a'.repeat(64);
const UID = 501;
const LABEL = `com.maka.runtime-host.${SERVICE_ID}`;
const DOMAIN = `gui/${String(UID)}`;
const TARGET = `${DOMAIN}/${LABEL}`;
const UPDATE_LABEL = `${LABEL}.update`;
const UPDATE_TARGET = `${DOMAIN}/${UPDATE_LABEL}`;

test('renders the canonical Runtime Host command as a private persistent LaunchAgent', () => {
  const config = fixtureConfig('/tmp/node & tool', '/tmp/maka <cli>', '/tmp/state > root');
  const plist = renderLaunchAgentPlist(
    config,
    {
      label: LABEL,
      stdoutPath: '/tmp/stdout & log',
      stderrPath: '/tmp/stderr < log',
    },
    '/tmp/runtime-host-service.json',
  );

  assert.match(
    plist,
    /<key>KeepAlive<\/key>\n  <dict>\n    <key>SuccessfulExit<\/key>\n    <false\/>\n  <\/dict>/u,
  );
  assert.match(plist, /<key>ExitTimeOut<\/key>\n  <integer>45<\/integer>/u);
  assert.match(plist, /<key>Umask<\/key>\n  <integer>63<\/integer>/u);
  assert.match(plist, /<string>\/tmp\/node &amp; tool<\/string>/u);
  assert.match(plist, /<string>\/tmp\/maka &lt;cli&gt;<\/string>/u);
  assert.match(plist, /<string>--managed-service-config<\/string>/u);
  assert.match(plist, /<string>\/tmp\/runtime-host-service\.json<\/string>/u);
  assert.doesNotMatch(plist, /state &gt; root|workspace=/u);
});

test('renders managed update reconciliation as a periodic one-shot LaunchAgent', () => {
  const config = {
    ...fixtureConfig('/tmp/node', '/tmp/maka', '/tmp/state'),
    managedDeploymentRoot: '/tmp/managed deployment',
  };
  const plist = renderLaunchAgentUpdatePlist(config, {
    label: UPDATE_LABEL,
    stdoutPath: '/tmp/update.stdout.log',
    stderrPath: '/tmp/update.stderr.log',
  });

  assert.match(plist, /<string>\/tmp\/managed deployment\/operator<\/string>/u);
  assert.match(plist, /<string>reconcile-update<\/string>/u);
  assert.match(plist, /<string>--framed<\/string>/u);
  assert.match(plist, /<key>StartInterval<\/key>\n  <integer>86400<\/integer>/u);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/u);
});

test('canonical LaunchAgent projection owns persistent enablement', async () => {
  await withFixture(async ({ homeDir, launchctl }) => {
    launchctl.disabled = true;
    launchctl.updateDisabled = true;
    const provider = createLaunchAgentRuntimeHostLifecycleProvider(SERVICE_ID, {
      homeDir,
      uid: UID,
      runLaunchctl: launchctl.run,
      isProcessAlive: () => false,
    });
    const supervisor = { command: [process.execPath, '/tmp/maka-cli.js'] as const };
    const reconciliation = {
      command: ['/tmp/maka-operator', 'reconcile-update', '--framed'] as const,
    };

    await provider.supervisor.converge(supervisor);
    await provider.reconciliationTrigger.converge(reconciliation);
    await provider.supervisor.verify(supervisor);
    await provider.reconciliationTrigger.verify(reconciliation);
    await provider.supervisor.activate();
    await provider.reconciliationTrigger.activate();

    assert.equal((await provider.supervisor.status()).enabled, true);
    assert.deepEqual(
      launchctl.calls.filter(([command]) => command === 'enable'),
      [
        ['enable', TARGET],
        ['enable', UPDATE_TARGET],
      ],
    );
    assert.equal(launchctl.loaded, true);
    assert.equal(launchctl.updateLoaded, true);
  });
});

test('installs and removes the update scheduler with a managed LaunchAgent', async () => {
  await withFixture(async ({ homeDir, cliPath, launchctl }) => {
    const backend = createLaunchAgentRuntimeHostService(SERVICE_ID, {
      serviceConfigPath: join(homeDir, 'runtime-host-service.json'),
      homeDir,
      uid: UID,
      runLaunchctl: launchctl.run,
      isProcessAlive: () => false,
    });
    const config = {
      ...fixtureConfig(process.execPath, cliPath, join(homeDir, 'state')),
      managedDeploymentRoot: join(homeDir, 'managed'),
    };

    await applyStagedDeployment(backend, config);
    await backend.verifyDeployment(config);
    const updatePath = resolveLaunchAgentUpdatePath(SERVICE_ID, homeDir);
    assert.match(await readFile(updatePath, 'utf8'), /reconcile-update/u);
    const logDirectory = join(homeDir, 'Library', 'Logs', 'Maka', 'runtime-host-services');
    await Promise.all([
      writeFile(join(logDirectory, `${LABEL}.stdout.log`), 'h'.repeat(64 * 1024)),
      writeFile(join(logDirectory, `${LABEL}.stderr.log`), 'host stderr'),
      writeFile(join(logDirectory, `${UPDATE_LABEL}.stdout.log`), 'update stdout'),
      writeFile(
        join(logDirectory, `${UPDATE_LABEL}.stderr.log`),
        'scheduler reconciliation failed',
      ),
    ]);
    const logs = await backend.logs();
    assert.match(logs, /scheduler reconciliation failed/u);
    assert.ok(Buffer.byteLength(logs) <= RUNTIME_HOST_SERVICE_LOG_MAX_BYTES);

    const updateBootouts = () =>
      launchctl.calls.filter(
        ([command, target]) => command === 'bootout' && target === UPDATE_TARGET,
      ).length;
    const bootoutsBeforeReplace = updateBootouts();
    await backend.replace(config);
    assert.equal(updateBootouts(), bootoutsBeforeReplace);

    launchctl.updateRunning = true;
    launchctl.failNextBootstrap = true;
    await assert.rejects(backend.replace(config), /Starting the Runtime Host LaunchAgent failed/u);
    assert.equal(updateBootouts(), bootoutsBeforeReplace);
    assert.equal(launchctl.updateRunning, true);
    launchctl.updateRunning = false;

    await writeFile(updatePath, '<plist>stale</plist>\n', { mode: 0o600 });
    await assert.rejects(
      backend.verifyReplacementPreconditions(config),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'target_mismatch',
    );
    await assert.rejects(
      backend.verifyDeployment(config),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'target_mismatch',
    );
    await applyStagedDeployment(backend, config);
    await backend.verifyDeployment(config);

    await backend.stop();
    assert.equal(launchctl.updateLoaded, false);
    await backend.verifyDeployment(config);
    await assert.rejects(
      backend.verifyDeployment(config, { requireSchedulerReady: true }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'target_mismatch',
    );
    await applyStagedDeployment(backend, config, { activate: false });
    assert.equal((await backend.status()).state, 'stopped');
    assert.equal(launchctl.updateLoaded, false);
    await backend.replace(config);
    assert.equal(launchctl.updateLoaded, true);
    await backend.verifyDeployment(config, { requireSchedulerReady: true });

    const { managedDeploymentRoot: _managedDeploymentRoot, ...unmanagedConfig } = config;
    await applyStagedDeployment(backend, unmanagedConfig);
    await backend.verifyDeployment(unmanagedConfig);
    assert.equal(await fileExists(updatePath), false);
    assert.equal(launchctl.updateLoaded, false);
    await backend.verifyReplacementPreconditions(config);
    await backend.replace(config);
    await backend.verifyDeployment(config);
    assert.equal(launchctl.updateLoaded, true);

    await backend.uninstall();
    assert.equal(await fileExists(updatePath), false);
  });
});

test('maps install, stop, start, restart, and uninstall onto one LaunchAgent service', async () => {
  await withFixture(async ({ homeDir, cliPath, launchctl }) => {
    let processChecks = 0;
    const backend = createLaunchAgentRuntimeHostService(SERVICE_ID, {
      serviceConfigPath: join(homeDir, 'runtime-host-service.json'),
      homeDir,
      uid: UID,
      runLaunchctl: launchctl.run,
      isProcessAlive: () => {
        processChecks += 1;
        return false;
      },
    });
    const config = fixtureConfig(process.execPath, cliPath, join(homeDir, 'state'));

    await backend.preflightDeployment();
    await applyStagedDeployment(backend, config);
    await backend.verifyDeployment(config);
    assert.deepEqual(await backend.status(), {
      manager: 'launch_agent',
      installed: true,
      enabled: true,
      active: true,
      state: 'running',
      pid: 4101,
      lastExitCode: 0,
    });
    launchctl.running = false;
    assert.deepEqual(await backend.status(), {
      manager: 'launch_agent',
      installed: true,
      enabled: true,
      active: false,
      state: 'stopped',
      pid: null,
      lastExitCode: 0,
    });
    launchctl.running = true;

    await backend.stop();
    assert.equal(processChecks, 1);
    assert.equal((await backend.status()).state, 'stopped');
    await backend.verifyDeployment(config);
    await backend.start();
    await backend.restart();
    assert.equal((await backend.status()).pid, 4103);

    await backend.uninstall();
    assert.equal((await backend.status()).state, 'not_installed');
    assert.equal(await fileExists(resolveLaunchAgentPath(SERVICE_ID, homeDir)), false);
    assert.deepEqual(
      launchctl.calls.filter(([command]) => command !== 'print'),
      [
        ['bootstrap', DOMAIN, resolveLaunchAgentPath(SERVICE_ID, homeDir)],
        ['bootout', TARGET],
        ['bootstrap', DOMAIN, resolveLaunchAgentPath(SERVICE_ID, homeDir)],
        ['kickstart', '-k', TARGET],
        ['bootout', TARGET],
      ],
    );
  });
});

test('recognizes and transactionally replaces the exact legacy LaunchAgent definition', async () => {
  await withFixture(async ({ homeDir, cliPath, launchctl }) => {
    const config = fixtureConfig(process.execPath, cliPath, join(homeDir, 'state'));
    const plistPath = resolveLaunchAgentPath(SERVICE_ID, homeDir);
    const legacyPlist = legacyLaunchAgentPlistFixture(config, homeDir);
    await writeFile(plistPath, legacyPlist, { mode: 0o600 });
    launchctl.loaded = true;
    launchctl.running = true;
    const backend = createLaunchAgentRuntimeHostService(SERVICE_ID, {
      serviceConfigPath: join(homeDir, 'runtime-host-service.json'),
      homeDir,
      uid: UID,
      runLaunchctl: launchctl.run,
      isProcessAlive: () => false,
    });

    await assert.rejects(
      backend.verifyDeployment(config),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'target_mismatch',
    );
    await backend.verifyDeployment(config, { acceptLegacyConfigLaunch: true });

    const deployment = await backend.stageDeployment();
    await backend.retire();
    await deployment.apply({ ...config, schemaVersion: 2 }, true);
    await backend.verifyDeployment({ ...config, schemaVersion: 2 });
    assert.match(await readFile(plistPath, 'utf8'), /--managed-service-config/u);

    await backend.retire();
    await deployment.rollback();
    assert.equal(await readFile(plistPath, 'utf8'), legacyPlist);
    assert.equal(launchctl.loaded, true);
    assert.equal(launchctl.running, true);
  });
});

test('restores the previous loaded LaunchAgent when deployment bootstrap fails', async () => {
  for (const action of ['install', 'replace'] as const) {
    await withFixture(async ({ homeDir, cliPath, launchctl }) => {
      const plistPath = resolveLaunchAgentPath(SERVICE_ID, homeDir);
      const previousPlist = '<plist>previous</plist>\n';
      await writeFile(plistPath, previousPlist, { mode: 0o600 });
      launchctl.loaded = true;
      launchctl.failNextBootstrap = true;
      const backend = createLaunchAgentRuntimeHostService(SERVICE_ID, {
        serviceConfigPath: join(homeDir, 'runtime-host-service.json'),
        homeDir,
        uid: UID,
        runLaunchctl: launchctl.run,
        isProcessAlive: () => false,
      });

      const config = fixtureConfig(process.execPath, cliPath, join(homeDir, 'state'));
      if (action === 'install') {
        const deployment = await backend.stageDeployment();
        await assert.rejects(
          deployment.apply(config, true),
          /Starting the Runtime Host LaunchAgent failed/u,
        );
        await deployment.rollback();
      } else {
        await assert.rejects(
          backend.replace(config),
          /Starting the Runtime Host LaunchAgent failed/u,
        );
      }
      assert.equal(await readFile(plistPath, 'utf8'), previousPlist);
      assert.equal(launchctl.loaded, true);
    });
  }
});

interface FakeLaunchctl {
  loaded: boolean;
  running: boolean;
  updateLoaded: boolean;
  updateRunning: boolean;
  disabled: boolean;
  updateDisabled: boolean;
  failNextBootstrap: boolean;
  readonly calls: string[][];
  readonly run: (args: readonly string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

function createFakeLaunchctl(): FakeLaunchctl {
  let pid = 4100;
  const fake: FakeLaunchctl = {
    loaded: false,
    running: false,
    updateLoaded: false,
    updateRunning: false,
    disabled: false,
    updateDisabled: false,
    failNextBootstrap: false,
    calls: [],
    run: async (args) => {
      fake.calls.push([...args]);
      if (args[0] === 'print' && args[1] === DOMAIN) {
        return { exitCode: 0, stdout: 'domain = gui\n', stderr: '' };
      }
      if (args[0] === 'print-disabled' && args[1] === DOMAIN) {
        return {
          exitCode: 0,
          stdout: [
            'disabled services = {',
            `  "${LABEL}" => ${fake.disabled ? 'disabled' : 'enabled'}`,
            `  "${UPDATE_LABEL}" => ${fake.updateDisabled ? 'disabled' : 'enabled'}`,
            '}',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (args[0] === 'print' && (args[1] === TARGET || args[1] === UPDATE_TARGET)) {
        const update = args[1] === UPDATE_TARGET;
        const loaded = update ? fake.updateLoaded : fake.loaded;
        const running = update ? fake.updateRunning : fake.running;
        return loaded
          ? {
              exitCode: 0,
              stdout: running
                ? `state = running\npid = ${String(pid)}\nlast exit code = 0\n`
                : 'state = not running\nlast exit code = 0\n',
              stderr: '',
            }
          : { exitCode: 113, stdout: '', stderr: 'Could not find service' };
      }
      if (args[0] === 'bootstrap') {
        if (fake.failNextBootstrap) {
          fake.failNextBootstrap = false;
          return { exitCode: 5, stdout: '', stderr: 'Input/output error' };
        }
        const update = args[2]?.endsWith('.update.plist') ?? false;
        if (update) {
          fake.updateLoaded = true;
          fake.updateRunning = false;
        } else {
          fake.loaded = true;
          fake.running = true;
        }
        pid += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'enable') {
        if (args[1] === UPDATE_TARGET) fake.updateDisabled = false;
        else if (args[1] === TARGET) fake.disabled = false;
        else throw new Error(`Unexpected launchctl enable target: ${String(args[1])}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'bootout') {
        if (args[1] === UPDATE_TARGET) {
          fake.updateRunning = false;
          fake.updateLoaded = false;
        } else {
          fake.running = false;
          fake.loaded = false;
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'kickstart') {
        fake.loaded = true;
        fake.running = true;
        pid += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected launchctl arguments: ${args.join(' ')}`);
    },
  };
  return fake;
}

function fixtureConfig(
  nodePath: string,
  cliPath: string,
  rootPath: string,
): RuntimeHostManagedServiceConfig {
  return {
    schemaVersion: 1,
    rootPath,
    projectDirectoryRoots: [{ label: 'workspace', path: '/tmp/projects' }],
    websocket: { host: '127.0.0.1', port: 23456, path: '/runtime-host' },
    launch: { nodePath, cliPath },
  };
}

function legacyLaunchAgentPlistFixture(
  config: RuntimeHostManagedServiceConfig,
  homeDir: string,
): string {
  const escape = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
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
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((value) => `    <string>${escape(value)}</string>`),
    '  </array>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>2</integer>',
    '  <key>ExitTimeOut</key>',
    '  <integer>45</integer>',
    '  <key>Umask</key>',
    '  <integer>63</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${escape(join(homeDir, 'Library', 'Logs', 'Maka', 'runtime-host-services', `${LABEL}.stdout.log`))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escape(join(homeDir, 'Library', 'Logs', 'Maka', 'runtime-host-services', `${LABEL}.stderr.log`))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

async function applyStagedDeployment(
  backend: RuntimeHostServiceBackend,
  config: RuntimeHostManagedServiceConfig,
  options?: { readonly activate?: boolean },
): Promise<RuntimeHostServiceDeployment> {
  const deployment = await backend.stageDeployment();
  await deployment.apply(config, options?.activate ?? true);
  return deployment;
}

async function withFixture(
  operation: (fixture: {
    homeDir: string;
    cliPath: string;
    launchctl: FakeLaunchctl;
  }) => Promise<void>,
): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'maka-launch-agent-test-'));
  const cliPath = join(homeDir, 'maka-cli.js');
  try {
    await writeFile(cliPath, '#!/usr/bin/env node\n', { mode: 0o700 });
    await chmod(cliPath, 0o700);
    await mkdir(join(homeDir, 'Library', 'LaunchAgents'), { recursive: true });
    await operation({ homeDir, cliPath, launchctl: createFakeLaunchctl() });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function fileExists(path: string): Promise<boolean> {
  return readFile(path)
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    });
}
