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
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createOpenRcRuntimeHostLifecycleProvider } from '../runtime-host-openrc-service.js';

const SERVICE_ID = 'a'.repeat(64);
const SERVICE_NAME = `maka-runtime-host-${SERVICE_ID}`;
const UPDATE_NAME = `${SERVICE_NAME}-update`;

test('OpenRC provider owns one supervised Host and reconciliation loop', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka openrc provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    initDirectory: join(root, 'init.d'),
    runlevelDirectory: join(root, 'runlevels', 'default'),
    artifactDirectory: join(root, 'artifacts'),
    logDirectory: join(root, 'logs'),
    stateDirectory: join(root, 'state'),
  };
  const active = new Set<string>();
  const calls: [string, readonly string[]][] = [];
  let runlevel = 'sysinit';
  const runCommand = async (command: string, args: readonly string[]) => {
    calls.push([command, args]);
    if (command === 'supervise-daemon' && args[0] === '--help') {
      return { exitCode: 1, stdout: '', stderr: 'usage' };
    }
    if (command === 'rc-service' && args[0] !== '--help') {
      const [name, action] = args;
      if (action === 'status') {
        return { exitCode: active.has(name!) ? 0 : 3, stdout: '', stderr: '' };
      }
      if (action === 'start') {
        active.add(name!);
        const state = join(paths.stateDirectory, 'options', name!);
        await mkdir(state, { recursive: true });
        await writeFile(join(state, 'child_pid'), name === SERVICE_NAME ? '4242\n' : '4343\n');
      } else if (action === 'stop') {
        active.delete(name!);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command === 'rc-update' && args[0] !== 'show') {
      const [action, name] = args;
      const link = join(paths.runlevelDirectory, name!);
      if (action === 'add') {
        await mkdir(paths.runlevelDirectory, { recursive: true });
        await symlink(join(paths.initDirectory, name!), link);
      } else if (action === 'del') {
        await unlink(link);
      }
    }
    return {
      exitCode: 0,
      stdout: command === 'rc-status' ? `${runlevel}\n` : '',
      stderr: '',
    };
  };
  const provider = createOpenRcRuntimeHostLifecycleProvider(SERVICE_ID, 'openrc_system', {
    uid: 0,
    paths,
    runCommand,
  });
  const supervisor = {
    command: [
      process.execPath,
      '/tmp/maka cli.js',
      "quote'value",
      '$(printf injected)',
      '*.js',
    ] as const,
  };
  const reconciliation = {
    command: ['/tmp/maka operator', 'reconcile-update', '--framed'] as const,
  };

  await assert.rejects(provider.supervisor.preflight(), { code: 'service_manager_unavailable' });
  runlevel = 'default';
  await provider.supervisor.preflight();
  await provider.supervisor.converge(supervisor);
  await provider.reconciliationTrigger.converge(reconciliation);
  await provider.supervisor.verify(supervisor);
  await provider.reconciliationTrigger.verify(reconciliation);
  const servicePath = join(paths.initDirectory, SERVICE_NAME);
  const evaluated = await promisify(execFile)('/bin/sh', [
    '-c',
    '. "$1"; eval "set -- --stdout $output_log --stderr $error_log $command -- $command_args"; printf "%s\\n" "$@"',
    'sh',
    servicePath,
  ]);
  assert.deepEqual(evaluated.stdout.trimEnd().split('\n'), [
    '--stdout',
    join(paths.logDirectory, 'host.stdout.log'),
    '--stderr',
    join(paths.logDirectory, 'host.stderr.log'),
    process.execPath,
    '--',
    '/tmp/maka cli.js',
    "quote'value",
    '$(printf injected)',
    '*.js',
  ]);
  await provider.supervisor.activate();
  await provider.reconciliationTrigger.activate();

  assert.deepEqual(await provider.supervisor.status(), {
    provider: 'openrc_system',
    installed: true,
    enabled: true,
    active: true,
    state: 'running',
    pid: 4242,
    lastExitCode: null,
  });
  assert.deepEqual(await provider.reconciliationTrigger.status(), {
    installed: true,
    active: true,
  });
  assert.match(await readFile(servicePath, 'utf8'), /retry=TERM\/20\/KILL\/5[\s\S]*respawn_max=0/u);
  assert.match(
    await readFile(join(paths.artifactDirectory, 'update'), 'utf8'),
    /reconcile-update[\s\S]*sleep 86400/u,
  );
  await writeFile(join(paths.logDirectory, 'host.stdout.log'), 'host output\n');
  assert.match(await provider.supervisor.logs(), /host output/u);

  await provider.reconciliationTrigger.uninstall();
  await provider.supervisor.uninstall();
  assert.equal(active.size, 0);
  await assert.rejects(lstat(join(paths.initDirectory, SERVICE_NAME)), { code: 'ENOENT' });
  await assert.rejects(lstat(join(paths.initDirectory, UPDATE_NAME)), { code: 'ENOENT' });
  assert.ok(calls.some(([command, args]) => command === 'rc-update' && args[0] === 'add'));
});
