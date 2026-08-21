import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runMakaEvalCli } from '../cli.js';

test('fails install preflight before starting an experiment attempt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-cli-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trials = join(root, 'trials');
  await mkdir(trials);
  const specPath = join(root, 'experiment.json');
  const outputPath = join(root, 'output');
  const missingMount = join(root, 'missing-toolchain');
  const previous = {
    python: process.env.MAKA_TEST_CLI_PYTHON,
    trials: process.env.MAKA_TEST_CLI_TRIALS,
    mount: process.env.MAKA_TEST_CLI_MOUNT,
  };
  process.env.MAKA_TEST_CLI_PYTHON = process.execPath;
  process.env.MAKA_TEST_CLI_TRIALS = trials;
  process.env.MAKA_TEST_CLI_MOUNT = missingMount;
  t.after(() => {
    restoreEnvironment('MAKA_TEST_CLI_PYTHON', previous.python);
    restoreEnvironment('MAKA_TEST_CLI_TRIALS', previous.trials);
    restoreEnvironment('MAKA_TEST_CLI_MOUNT', previous.mount);
  });
  await writeFile(specPath, JSON.stringify(experiment()));
  let stderr = '';

  const exitCode = await runMakaEvalCli(['run', specPath, '--out', outputPath], {
    stdout: () => assert.fail('preflight failure must not write a result'),
    stderr: (text) => {
      stderr += text;
    },
  });

  assert.equal(exitCode, 2);
  assert.match(stderr, /machine path MAKA_TEST_CLI_MOUNT does not exist/);
  assert.deepEqual(await readdir(outputPath), ['experiment.json']);
});

function experiment() {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'preflight',
    benchmark: { id: 'benchmark', version: '1', config: {} },
    executor: {
      kind: 'harbor',
      config: {
        frameworkVersion: '0.20.0',
        pythonPathEnv: 'MAKA_TEST_CLI_PYTHON',
        trialsRootEnv: 'MAKA_TEST_CLI_TRIALS',
        environment: { type: 'docker' },
        preparationEnvironment: [],
        mounts: [{ sourceEnv: 'MAKA_TEST_CLI_MOUNT', target: '/opt/toolchain', readOnly: true }],
      },
    },
    subjects: [{ id: 'subject', kind: 'external', credentials: [], config: {} }],
    tasks: [{ id: 'task', input: 'do work', config: {} }],
    repetitions: 1,
    budget: {},
    verifier: {},
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
