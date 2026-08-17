import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { preflightBuiltinExecutor } from '../install-preflight.js';
import { parseExperimentSpec } from '../spec.js';

test('preflights the pinned Python framework and Docker before execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-install-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trials = join(root, 'trials');
  const mount = join(root, 'mount');
  await Promise.all([mkdir(trials), mkdir(mount)]);
  const restore = setMachinePaths({
    MAKA_TEST_PREFLIGHT_PYTHON: process.execPath,
    MAKA_TEST_PREFLIGHT_TRIALS: trials,
    MAKA_TEST_PREFLIGHT_MOUNT: mount,
    MAKA_TEST_PREFLIGHT_SECRET: 'must-not-reach-preflight-processes',
  });
  t.after(restore);
  const calls: {
    command: string;
    args: readonly string[];
    environment: NodeJS.ProcessEnv;
    cwd: string;
  }[] = [];

  await preflightBuiltinExecutor(
    experiment('MAKA_TEST_PREFLIGHT_SECRET'),
    join(root, 'spec.json'),
    {
      runCommand: async (command, args, environment, cwd) => {
        calls.push({ command, args, environment, cwd });
      },
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.command, process.execPath);
  assert.deepEqual(calls[0]?.args.slice(-3), ['harbor', '0.20.0', 'harbor']);
  assert.equal(calls[0]?.environment.MAKA_TEST_PREFLIGHT_SECRET, undefined);
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
    preflightBuiltinExecutor(experiment(), join(root, 'spec.json'), {
      runCommand: async () => {
        commands += 1;
      },
    }),
    /machine path MAKA_TEST_PREFLIGHT_MOUNT does not exist/,
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
    preflightBuiltinExecutor(experiment(), join(root, 'spec.json'), {
      runCommand: async () => {
        throw new Error('installed 0.19.0, expected 0.20.0');
      },
    }),
    /harbor Python environment MAKA_TEST_PREFLIGHT_PYTHON .* harbor@0\.20\.0: installed 0\.19\.0/,
  );
});

function experiment(credential?: string) {
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
