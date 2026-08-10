import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHarborExecutor } from '../harness-executor.js';

test('harness spawn failure releases its relay listener and process', async () => {
  const child = spawn(
    process.execPath,
    [new URL('./fixtures/harness-preparation-worker.js', import.meta.url).pathname],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  const exited = await new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(false), 1_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
  if (!exited) child.kill('SIGKILL');

  assert.equal(exited, true);
  assert.equal(output, 'SETTLED\n');
});

test('unknown Trial exception stays replaceable after subject failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-trial-exception-'));
  const executable = join(root, 'fake-python.mjs');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { connect } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const config = JSON.parse(await readFile(process.argv.at(-1), 'utf8'));
const socket = connect(config.agent.kwargs.relay_port, config.agent.kwargs.relay_host);
socket.setEncoding('utf8');
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
const lines = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
const next = async () => JSON.parse((await lines.next()).value);
socket.write(JSON.stringify({ token: config.agent.kwargs.relay_token, kind: 'ready', instruction: 'solve' }) + '\\n');
await next();
socket.write(JSON.stringify({ token: config.agent.kwargs.relay_token, kind: 'executed', termination: 'exited', exitCode: 1, stdout: '' }) + '\\n');
await next();
socket.end();
const trial = config.trials_dir + '/' + config.trial_name;
await mkdir(trial, { recursive: true });
await writeFile(trial + '/result.json', JSON.stringify({ exception_info: { exception_type: 'ContainerFinalizationError' }, verifier_result: { rewards: { reward: 1 } } }));
`,
  );
  await chmod(executable, 0o755);
  const previousPython = process.env.MAKA_TEST_PYTHON;
  const previousTrials = process.env.MAKA_TEST_TRIALS;
  process.env.MAKA_TEST_PYTHON = executable;
  process.env.MAKA_TEST_TRIALS = root;
  try {
    const executor = createHarborExecutor(
      {
        frameworkVersion: '0.20.0',
        pythonPathEnv: 'MAKA_TEST_PYTHON',
        trialsRootEnv: 'MAKA_TEST_TRIALS',
        containerCwd: '/app',
        environment: {},
        mounts: [],
      },
      join(root, 'spec.json'),
    );
    await assert.rejects(
      executor.runAttempt(
        {
          cell: {
            id: 'task::1::subject',
            experimentId: 'experiment',
            benchmark: { id: 'benchmark', version: 'version', config: { repository: 'repo' } },
            executor: { kind: 'harbor', config: {} },
            subject: { id: 'subject', kind: 'external', credentials: [], config: {} },
            task: { id: 'task', input: 'solve', config: { harbor: { path: 'task' } } },
            repetition: 1,
            budget: { timeoutMultiplier: 1 },
            verifier: { reward: 'reward' },
          },
        },
        async ({ context, verify }) => {
          const execution = await context.execute({
            command: '/opt/subject',
            args: [],
            credentialNames: [],
          });
          const subject = {
            usage: null,
            costUsd: null,
            durationMs: 1,
            status: 'failed' as const,
            failureReason: `subject exited ${execution.exitCode}`,
            artifacts: [],
          };
          const verification = await verify();
          return {
            score: verification.score,
            usage: null,
            costUsd: null,
            durationMs: 1,
            status: 'subject_failed',
            failureReason: subject.failureReason,
            artifacts: verification.artifacts,
          };
        },
      ),
      /Trial failed outside subject execution/u,
    );
  } finally {
    if (previousPython === undefined) delete process.env.MAKA_TEST_PYTHON;
    else process.env.MAKA_TEST_PYTHON = previousPython;
    if (previousTrials === undefined) delete process.env.MAKA_TEST_TRIALS;
    else process.env.MAKA_TEST_TRIALS = previousTrials;
    await rm(root, { recursive: true, force: true });
  }
});
