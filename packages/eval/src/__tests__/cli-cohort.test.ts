import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runMakaEvalCli } from '../cli.js';
import { expandExperiment } from '../experiment.js';
import { createExternalSubjectAdapter } from '../external-subject.js';
import { createMakaSubjectAdapter } from '../maka-subject.js';
import type { ExperimentExecutor, SubjectAdapter } from '../runner.js';
import { parseExperimentSpec } from '../spec.js';

const execFileAsync = promisify(execFile);

test('maka eval publishes only immutable attempts from one spec', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-cli-'));
  const specPath = join(root, 'spec.json');
  await writeFile(specPath, JSON.stringify(spec()));
  const output: string[] = [];
  const executor: ExperimentExecutor = {
    kind: 'harbor',
    runAttempt: async (_input, operation) => ({
      kind: 'settled',
      value: await operation({
        context: {
          cwd: '/app',
          taskInput: 'solve',
          metadata: {},
          execute: async () => ({ termination: 'exited', exitCode: 0, stdout: '' }),
        },
        verify: async () => ({
          status: 'completed',
          score: 1,
          failureReason: null,
          artifacts: [],
        }),
      }),
    }),
  };
  const subject: SubjectAdapter = {
    kind: 'maka',
    execute: async () => ({
      usage: null,
      costUsd: null,
      durationMs: 1,
      status: 'completed',
      failureReason: null,
      artifacts: [],
    }),
  };

  assert.equal(
    await runMakaEvalCli(['run', specPath, '--out', join(root, 'run')], {
      loadExecutor: () => executor,
      subjects: [subject],
      stdout: (text) => output.push(text),
      stderr: assert.fail,
    }),
    0,
  );
  assert.deepEqual(JSON.parse(output[0] ?? ''), {
    experimentId: 'cli-test',
    cells: 1,
    incomplete: 0,
  });
  await assert.rejects(stat(join(root, 'run', 'results.json')), { code: 'ENOENT' });
});

test('competitor wrapper installs declared containment and provider policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-profiles-'));
  const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
  await execFileAsync(process.execPath, [
    wrapper.pathname,
    'codex',
    'https://provider.test',
    root,
    '/usr/bin/true',
  ]);
  await execFileAsync(process.execPath, [
    wrapper.pathname,
    'claude-code',
    'https://provider.test',
    root,
    '/usr/bin/true',
  ]);
  await execFileAsync(
    process.execPath,
    [
      wrapper.pathname,
      'reasonix',
      'https://provider.test',
      root,
      '/usr/bin/true',
      '--model',
      'maka-proxy/model',
      '--effort',
      'max',
    ],
    { env: { ...process.env, OPENAI_API_KEY: 'test-only-secret' } },
  );

  assert.match(await readFile(join(root, 'etc/codex/requirements.toml'), 'utf8'), /disabled/u);
  assert.match(
    await readFile(join(root, 'etc/claude-code/managed-settings.json'), 'utf8'),
    /WebSearch/u,
  );
  assert.match(
    await readFile(join(root, 'tmp/maka-reasonix/config.toml'), 'utf8'),
    /bash = "off"/u,
  );
  await assert.rejects(stat(join(root, 'tmp/maka-reasonix/.env')), { code: 'ENOENT' });
});

test('Reasonix wrapper removes its credential before cancellation settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-reasonix-cancel-'));
  const credential = join(root, 'tmp/maka-reasonix/.env');
  const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
  const child = spawn(
    process.execPath,
    [
      wrapper.pathname,
      'reasonix',
      'https://provider.test',
      root,
      '/bin/sh',
      '-c',
      'trap "exit 0" TERM; while :; do sleep 1; done',
      '--model',
      'maka-proxy/model',
      '--effort',
      'max',
    ],
    { env: { ...process.env, OPENAI_API_KEY: 'test-only-secret' }, stdio: 'ignore' },
  );
  while (
    await stat(credential).then(
      () => false,
      () => true,
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  child.kill('SIGTERM');
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });

  await assert.rejects(stat(credential), { code: 'ENOENT' });
});

test('checked-in cohort is one fully expanded four-arm experiment', async () => {
  const path = new URL(
    '../../experiments/terminal-bench-2.1-deepseek-v4-flash-four-arm.json',
    import.meta.url,
  );
  const parsed = parseExperimentSpec(JSON.parse(await readFile(path, 'utf8')) as unknown);
  assert.equal(parsed.tasks.length, 89);
  assert.deepEqual(
    parsed.subjects.map(({ id }) => id),
    ['maka', 'codex', 'claude-code', 'reasonix'],
  );
  assert.equal(expandExperiment(parsed).length, 356);
  const adapters = [createMakaSubjectAdapter(), createExternalSubjectAdapter()];
  for (const cell of expandExperiment(parsed).slice(0, 4)) {
    adapters.find(({ kind }) => kind === cell.subject.kind)?.validate?.(cell);
  }
});

function spec() {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'cli-test',
    benchmark: { id: 'benchmark', version: 'version', config: {} },
    executor: { kind: 'harbor', config: {} },
    execution: { maxConcurrentTaskGroups: 1 },
    subjects: [{ id: 'maka', kind: 'maka', credentials: [], config: {} }],
    tasks: [{ id: 'task', input: 'solve', config: {} }],
    repetitions: 1,
    budget: {},
    verifier: {},
  };
}
