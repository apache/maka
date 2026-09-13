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
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarborExecutor } from '../harness-executor.js';
import type { HarnessPreflightDependencies } from '../install-preflight.js';
import type { ExperimentSpec } from '../experiment.js';
import { parseExperimentSpec } from '../spec.js';

test('preflights the pinned Python framework and Docker before execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-install-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trials = join(root, 'trials');
  const mount = join(root, 'mount');
  const egressTarget = join(root, 'egress-target');
  const egress = join(root, 'egress');
  await Promise.all([mkdir(trials), mkdir(mount), mkdir(egressTarget)]);
  await symlink(egressTarget, egress, process.platform === 'win32' ? 'junction' : 'dir');
  await Promise.all([
    writeFile(join(egressTarget, 'compose.yaml'), 'services: {}\n'),
    writeFile(join(egressTarget, 'network-policy.json'), '{}\n'),
  ]);
  const restore = setMachinePaths({
    MAKA_TEST_PREFLIGHT_PYTHON: process.execPath,
    MAKA_TEST_PREFLIGHT_TRIALS: trials,
    MAKA_TEST_PREFLIGHT_MOUNT: mount,
    MAKA_TEST_PREFLIGHT_EGRESS: egress,
    MAKA_TEST_PREFLIGHT_SECRET: 'must-not-reach-preflight-processes',
  });
  t.after(restore);
  const calls: {
    command: string;
    args: readonly string[];
    environment: NodeJS.ProcessEnv;
    cwd: string;
  }[] = [];

  await preflight(experiment('MAKA_TEST_PREFLIGHT_SECRET', true), join(root, 'spec.json'), {
    runCommand: async (command, args, environment, cwd) => {
      calls.push({ command, args, environment, cwd });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.command, process.execPath);
  assert.deepEqual(calls[0]?.args.slice(-3), ['harbor', '0.20.0', 'harbor']);
  assert.equal(calls[0]?.environment.MAKA_TEST_PREFLIGHT_SECRET, undefined);
  assert.equal(calls[0]?.environment.MAKA_EVAL_EGRESS_REQUIRED, '1');
  assert.equal(calls[0]?.environment.MAKA_EVAL_EGRESS_ALLOWED_HOST, 'api.example.test');
  const networkPolicyPath = join(egress, 'network-policy.json');
  const canonicalNetworkPolicyPath = await realpath(networkPolicyPath);
  assert.notEqual(canonicalNetworkPolicyPath, networkPolicyPath);
  assert.equal(calls[0]?.environment.MAKA_EVAL_NETWORK_POLICY_PATH, canonicalNetworkPolicyPath);
  assert.deepEqual(calls[1], {
    command: 'docker',
    args: ['version', '--format', '{{.Server.Version}}'],
    environment: calls[0]?.environment,
    cwd: root,
  });
});

test('reports a missing machine mount before invoking external prerequisites', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-install-mount-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trials = join(root, 'trials');
  await mkdir(trials);
  const restore = setMachinePaths({
    MAKA_TEST_PREFLIGHT_PYTHON: process.execPath,
    MAKA_TEST_PREFLIGHT_TRIALS: trials,
    MAKA_TEST_PREFLIGHT_MOUNT: join(root, 'missing-toolchain'),
  });
  t.after(restore);
  let commands = 0;

  await assert.rejects(
    preflight(experiment(), join(root, 'spec.json'), {
      runCommand: async () => {
        commands += 1;
      },
    }),
    /machine path MAKA_TEST_PREFLIGHT_MOUNT does not exist/,
  );
  assert.equal(commands, 0);
});

test('rejects an unusable trials root before invoking external prerequisites', {
  skip: process.platform === 'win32' || process.geteuid?.() === 0,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-install-trials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trials = join(root, 'trials');
  const mount = join(root, 'mount');
  await Promise.all([mkdir(trials), mkdir(mount)]);
  await chmod(trials, 0o500);
  const restore = setMachinePaths({
    MAKA_TEST_PREFLIGHT_PYTHON: process.execPath,
    MAKA_TEST_PREFLIGHT_TRIALS: trials,
    MAKA_TEST_PREFLIGHT_MOUNT: mount,
  });
  t.after(restore);
  let commands = 0;

  await assert.rejects(
    preflight(experiment(), join(root, 'spec.json'), {
      runCommand: async () => {
        commands += 1;
      },
    }),
    /machine path MAKA_TEST_PREFLIGHT_TRIALS is not writable and searchable/,
  );
  assert.equal(commands, 0);
});

test('rejects a dangling trials root symlink before invoking external prerequisites', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-install-trials-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trials = join(root, 'trials');
  const mount = join(root, 'mount');
  await mkdir(mount);
  try {
    await symlink(join(root, 'missing-trials'), trials, 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('symlinks require additional privileges on this platform');
      return;
    }
    throw error;
  }
  const restore = setMachinePaths({
    MAKA_TEST_PREFLIGHT_PYTHON: process.execPath,
    MAKA_TEST_PREFLIGHT_TRIALS: trials,
    MAKA_TEST_PREFLIGHT_MOUNT: mount,
  });
  t.after(restore);
  let commands = 0;

  await assert.rejects(
    preflight(experiment(), join(root, 'spec.json'), {
      runCommand: async () => {
        commands += 1;
      },
    }),
    /machine path MAKA_TEST_PREFLIGHT_TRIALS is a dangling symbolic link/,
  );
  assert.equal(commands, 0);
});

test('identifies a mismatched Python framework environment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-install-python-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trials = join(root, 'trials');
  const mount = join(root, 'mount');
  await Promise.all([mkdir(trials), mkdir(mount)]);
  const restore = setMachinePaths({
    MAKA_TEST_PREFLIGHT_PYTHON: process.execPath,
    MAKA_TEST_PREFLIGHT_TRIALS: trials,
    MAKA_TEST_PREFLIGHT_MOUNT: mount,
  });
  t.after(restore);

  await assert.rejects(
    preflight(experiment(), join(root, 'spec.json'), {
      runCommand: async () => {
        throw new Error('installed 0.19.0, expected 0.20.0');
      },
    }),
    /harbor Python environment MAKA_TEST_PREFLIGHT_PYTHON .* harbor@0\.20\.0: installed 0\.19\.0/,
  );
});

test('rejects egress assets that escape their declared source root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-install-egress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trials = join(root, 'trials');
  const mount = join(root, 'mount');
  const egress = join(root, 'egress');
  await Promise.all([mkdir(trials), mkdir(mount), mkdir(egress)]);
  const restore = setMachinePaths({
    MAKA_TEST_PREFLIGHT_PYTHON: process.execPath,
    MAKA_TEST_PREFLIGHT_TRIALS: trials,
    MAKA_TEST_PREFLIGHT_MOUNT: mount,
    MAKA_TEST_PREFLIGHT_EGRESS: egress,
  });
  t.after(restore);
  let commands = 0;

  await assert.rejects(
    preflight(experiment(undefined, true, 'nested/../../compose.yaml'), join(root, 'spec.json'), {
      runCommand: async () => {
        commands += 1;
      },
    }),
    /egress proxy compose path escapes its source root/,
  );
  assert.equal(commands, 0);
});

test('rejects egress assets that escape through a symlink', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-install-egress-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trials = join(root, 'trials');
  const mount = join(root, 'mount');
  const egress = join(root, 'egress');
  await Promise.all([mkdir(trials), mkdir(mount), mkdir(egress)]);
  await Promise.all([
    writeFile(join(root, 'outside-compose.yaml'), 'services: {}\n'),
    writeFile(join(egress, 'network-policy.json'), '{}\n'),
  ]);
  try {
    await symlink('../outside-compose.yaml', join(egress, 'compose-link.yaml'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('symlinks require additional privileges on this platform');
      return;
    }
    throw error;
  }
  const restore = setMachinePaths({
    MAKA_TEST_PREFLIGHT_PYTHON: process.execPath,
    MAKA_TEST_PREFLIGHT_TRIALS: trials,
    MAKA_TEST_PREFLIGHT_MOUNT: mount,
    MAKA_TEST_PREFLIGHT_EGRESS: egress,
  });
  t.after(restore);

  await assert.rejects(
    preflight(experiment(undefined, true, 'compose-link.yaml'), join(root, 'spec.json'), {
      runCommand: async () => assert.fail('symlink escape must fail before external probes'),
    }),
    /egress proxy compose path escapes its source root/,
  );
});

test('propagates cancellation to an active prerequisite probe', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-install-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trials = join(root, 'trials');
  const mount = join(root, 'mount');
  await Promise.all([mkdir(trials), mkdir(mount)]);
  const restore = setMachinePaths({
    MAKA_TEST_PREFLIGHT_PYTHON: process.execPath,
    MAKA_TEST_PREFLIGHT_TRIALS: trials,
    MAKA_TEST_PREFLIGHT_MOUNT: mount,
  });
  t.after(restore);
  const controller = new AbortController();
  const reason = new Error('preflight cancelled');
  let commands = 0;

  await assert.rejects(
    preflight(
      experiment(),
      join(root, 'spec.json'),
      {
        runCommand: async (_command, _args, _environment, _cwd, signal) => {
          commands += 1;
          assert.equal(signal, controller.signal);
          controller.abort(reason);
          signal?.throwIfAborted();
        },
      },
      controller.signal,
    ),
    reason,
  );
  assert.equal(commands, 1);
});

function experiment(credential?: string, egress = false, composeRelativePath = 'compose.yaml') {
  return parseExperimentSpec({
    schemaVersion: 'maka.eval.v1',
    id: 'preflight',
    benchmark: { id: 'benchmark', version: '1', config: {} },
    executor: {
      kind: 'harbor',
      config: {
        frameworkVersion: '0.20.0',
        pythonPathEnv: 'MAKA_TEST_PREFLIGHT_PYTHON',
        trialsRootEnv: 'MAKA_TEST_PREFLIGHT_TRIALS',
        environment: { type: 'docker' },
        preparationEnvironment: credential ? [credential] : [],
        mounts: [
          {
            sourceEnv: 'MAKA_TEST_PREFLIGHT_MOUNT',
            target: '/opt/toolchain',
            readOnly: true,
          },
        ],
        ...(egress
          ? {
              egressProxy: {
                composeSourceEnv: 'MAKA_TEST_PREFLIGHT_EGRESS',
                composeRelativePath,
                networkPolicyRelativePath: 'network-policy.json',
                proxyUrl: 'http://maka-eval-mitmproxy:8080',
                allowedHost: 'api.example.test',
                containerCaPath: '/opt/maka/ca.pem',
              },
            }
          : {}),
      },
    },
    subjects: [
      {
        id: 'subject',
        kind: 'external',
        credentials: credential ? [credential] : [],
        config: {},
      },
    ],
    tasks: [{ id: 'task', input: 'do work', config: {} }],
    repetitions: 1,
    budget: {},
    verifier: {},
  });
}

function preflight(
  spec: ExperimentSpec,
  specPath: string,
  dependencies: Partial<HarnessPreflightDependencies>,
  signal?: AbortSignal,
): Promise<void> {
  if (spec.executor.kind !== 'harbor') throw new Error('test requires Harbor');
  const executor = createHarborExecutor(spec.executor.config, specPath);
  return executor.preflight(
    {
      subjectCredentialNames: spec.subjects.flatMap((subject) => subject.credentials),
      ...(signal ? { signal } : {}),
    },
    dependencies,
  );
}

function setMachinePaths(values: Readonly<Record<string, string>>): () => void {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  ) as Record<string, string | undefined>;
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
