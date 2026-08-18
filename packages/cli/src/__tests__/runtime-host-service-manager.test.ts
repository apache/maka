import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import { runManagedRuntimeHostServiceCli } from '../runtime-host-service-management-command.js';
import {
  manageRuntimeHostService,
  resolveRuntimeHostManagedServiceConfigPath,
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
    assert.deepEqual(parseRuntimeHostCommand(['service', 'uninstall', '--json']), {
      kind: 'runtime-host-service-manage',
      action: 'uninstall',
      json: true,
    });
    assert.equal(parseRuntimeHostCommand(['service', 'status', '--root', '/tmp']).kind, 'error');
  });

  it('installs, reports, and cleanly uninstalls while retaining the State Root', async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const homeDir = join(base, 'home');
    const clientDataRoot = join(base, 'config', 'Maka');
    const rootPath = join(base, 'state root');
    const projectPath = join(base, 'projects');
    const cliPath = join(base, 'maka cli.js');
    await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
    await writeFile(join(base, 'placeholder'), '', 'utf8');
    await mkdir(projectPath, { recursive: true });
    const env = { XDG_CONFIG_HOME: join(base, 'xdg-config') };
    const configPath = resolveRuntimeHostManagedServiceConfigPath(clientDataRoot);
    const unitPath = resolveSystemdUserRuntimeHostServicePath(env, homeDir);
    const systemd = createFakeSystemd(unitPath);
    const backend = () =>
      createSystemdUserRuntimeHostService({
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
      cliPath,
      packageVersion: '0.1.0-beta.1',
    } as const;

    const installed = await manageRuntimeHostService(
      {
        ...common,
        action: 'install',
        projectDirectoryRoots: [{ label: 'Projects', path: projectPath }],
        websocketPort: 47_777,
      },
      backend(),
      {
        allocateLoopbackPort: async () => 49_999,
      },
    );
    assert.equal(installed.service.active, true);
    assert.equal(installed.service.configured, true);
    assert.equal(installed.service.enabled, true);
    assert.equal(installed.service.config?.websocket.port, 47_777);
    assert.match(await readFile(unitPath, 'utf8'), /ExecStart=.*runtime-host.*serve/u);
    assert.deepEqual(systemd.calls.slice(0, 4), [
      ['show-environment'],
      ['daemon-reload'],
      ['enable', 'maka-runtime-host.service'],
      ['restart', 'maka-runtime-host.service'],
    ]);

    const reinstalled = await manageRuntimeHostService(
      { ...common, action: 'install' },
      backend(),
      {
        allocateLoopbackPort: async () => 49_999,
      },
    );
    assert.equal(reinstalled.service.config?.websocket.port, 47_777);
    assert.deepEqual(reinstalled.service.config?.projectDirectoryRoots, [
      { label: 'Projects', path: await realpath(projectPath) },
    ]);
    assert.equal(reinstalled.service.lastExitCode, 0);

    const uninstalled = await manageRuntimeHostService(
      { ...common, action: 'uninstall' },
      backend(),
    );
    assert.equal(uninstalled.service.installed, false);
    assert.equal(uninstalled.service.configured, false);
    assert.equal(uninstalled.service.state, 'not_installed');
    assert.equal(uninstalled.retainedStateRoot, await realpath(rootPath));
    await access(rootPath);
    await assert.rejects(access(configPath));
    await assert.rejects(access(unitPath));

    const repeated = await manageRuntimeHostService({ ...common, action: 'uninstall' }, backend());
    assert.equal(repeated.service.installed, false);

    await mkdir(join(clientDataRoot), { recursive: true });
    await writeFile(configPath, '{not-json', 'utf8');
    const repaired = await manageRuntimeHostService({ ...common, action: 'uninstall' }, backend());
    assert.equal(repaired.service.installed, false);
    await assert.rejects(access(configPath));
  });

  it('quotes systemd arguments without exposing specifier or environment expansion', () => {
    const config: RuntimeHostManagedServiceConfig = {
      schemaVersion: 1,
      rootPath: '/srv/Maka 100%',
      projectDirectoryRoots: [{ label: 'Cash$', path: '/home/ada/My Projects' }],
      websocket: { host: '127.0.0.1', port: 7443, path: '/runtime-host' },
      launch: {
        nodePath: '/opt/Node 24/bin/node',
        cliPath: '/opt/Maka/current/cli.js',
        packageVersion: '0.1.0-beta.1',
      },
    };
    const unit = renderSystemdUnit(config);
    assert.match(unit, /"\/srv\/Maka 100%%"/u);
    assert.match(unit, /"Cash\$\$=\/home\/ada\/My Projects"/u);
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
        packageVersion: '0.1.0-beta.1',
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
});

function createFakeSystemd(unitPath: string): {
  readonly calls: string[][];
  readonly run: (args: readonly string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
} {
  const calls: string[][] = [];
  let loaded = false;
  let enabled = false;
  let active = false;
  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
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
    uninstall: unexpected,
  };
}

function success(stdout = ''): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout, stderr: '' };
}
