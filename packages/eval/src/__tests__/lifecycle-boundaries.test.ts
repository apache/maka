import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { FileAttemptStore } from '../attempt-store.js';
import type { ExperimentCell, ExperimentSpec, JsonObject } from '../experiment.js';
import { createExternalSubjectAdapter } from '../external-subject.js';
import { createHarborExecutor } from '../harness-executor.js';
import { disabledWebToolsRuntimePolicyDocument } from '../maka-runtime-policy.js';
import { createMakaSubjectAdapter } from '../maka-subject.js';
import {
  runExperiment,
  type ExperimentExecutor,
  type SubjectAdapter,
  type SubjectExecutionContext,
} from '../runner.js';

const TEST_REVISION = 'd49e28f1e4ddd13d289e85a5f312a66750951932';
const execFileAsync = promisify(execFile);

test('cancellation while waiting for relay connection escalates and releases ownership', {
  timeout: 30_000,
}, async () => {
  await verifyPreparationCancellation('connection', true);
});

test('cancellation while waiting for ready line enters bounded cleanup', {
  timeout: 5_000,
}, async () => {
  await verifyPreparationCancellation('ready', false);
});

test('Maka framework termination is authoritative before stdout decoding', async () => {
  for (const stdout of ['', '{']) {
    const result = await executeMaka('framework_timeout', () => stdout);
    assert.equal(result.status, 'failed');
    assert.equal(result.failureReason, 'Maka subject exceeded the framework timeout');
    assert.equal(result.usage, null);
    assert.equal(result.costUsd, null);
  }

  const retained = await executeMaka('framework_timeout', (executionId) =>
    JSON.stringify({
      executionId,
      kind: 'settled',
      status: 'cancelled',
      usage: usage(),
      costUsd: null,
    }),
  );
  assert.equal(retained.status, 'failed');
  assert.deepEqual(retained.usage, usage());
  assert.ok(Math.abs((retained.costUsd ?? 0) - 0.0000029087) < 1e-15);

  const cancelled = await executeMaka('cancelled', () => '');
  assert.equal(cancelled.status, 'indeterminate');
  assert.equal(cancelled.failureReason, 'Maka subject cancelled');

  const external = await createExternalSubjectAdapter().execute({
    cell: cell('external', { command: '/opt/competitor', args: [] }),
    context: {
      cwd: '/app',
      taskInput: 'solve',
      metadata: {},
      execute: async () => ({ termination: 'framework_timeout', exitCode: 124, stdout: '' }),
    },
  });
  assert.equal(external.status, 'failed');
});

test('subject preflight settles before the attempt timer starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-preflight-order-'));
  const events: string[] = [];
  const executor: ExperimentExecutor = {
    kind: 'harbor',
    runAttempt: async (_input, operation) => ({
      kind: 'settled',
      value: await operation({
        context: {
          cwd: '/app',
          taskInput: 'solve',
          metadata: {},
          execute: async () => assert.fail('preflight ordering test does not execute a process'),
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
    kind: 'external',
    prepare: async () => {
      events.push('prepare');
    },
    execute: async () => {
      events.push('execute');
      return {
        usage: null,
        costUsd: null,
        durationMs: 1,
        status: 'completed',
        failureReason: null,
        artifacts: [],
      };
    },
  };
  let now = 0;
  try {
    await runExperiment({
      spec: experiment(),
      store: new FileAttemptStore(join(root, 'attempts')),
      executor,
      subjects: [subject],
      now: () => {
        events.push('timer');
        now += 1;
        return now;
      },
    });
    assert.deepEqual(events, ['prepare', 'timer', 'execute', 'timer']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('eight-arm spec and wrappers freeze the working provider contracts', async () => {
  const specPath = new URL(
    '../../experiments/terminal-bench-2.1-deepseek-v4-flash-eight-arm.json',
    import.meta.url,
  );
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as {
    subjects: Array<{
      id: string;
      credentials: string[];
      config: {
        connectionSlug?: string;
        baseUrl?: string;
        args?: string[];
        credentialEnvironment?: Record<string, string>;
      };
    }>;
  };
  const maka = spec.subjects.find(({ id }) => id === 'maka')!;
  const codex = spec.subjects.find(({ id }) => id === 'codex')!;
  const claude = spec.subjects.find(({ id }) => id === 'claude-code')!;
  assert.deepEqual(maka.credentials, ['DEEPSEEK_API_KEY']);
  assert.equal(maka.config.connectionSlug, 'env-deepseek');
  assert.equal(maka.config.baseUrl, 'https://api.deepseek.com');
  assert.equal(codex.config.args?.includes('--ephemeral'), true);
  assert.equal(codex.config.args?.includes('--skip-git-repo-check'), true);
  assert.equal(claude.config.args?.includes('--bare'), true);
  assert.equal(claude.config.args?.includes('--effort'), true);
  for (const subject of spec.subjects) {
    assert.deepEqual(subject.credentials, ['DEEPSEEK_API_KEY']);
    if (subject.id === 'maka') continue;
    assert.deepEqual(subject.config.credentialEnvironment, {
      [subject.id === 'claude-code' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY']: 'DEEPSEEK_API_KEY',
    });
  }

  const root = await mkdtemp(join(tmpdir(), 'maka-eval-profiles-'));
  const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
  const env = {
    ...process.env,
    OPENAI_API_KEY: 'test-only-key',
    ANTHROPIC_API_KEY: 'test-only-key',
  };
  try {
    for (const args of [
      ['codex', 'https://api.deepseek.com', root, '/usr/bin/true'],
      ['claude-code', 'https://api.deepseek.com/anthropic', root, '/usr/bin/true'],
      [
        'reasonix',
        'https://api.deepseek.com',
        root,
        '/usr/bin/true',
        '--model',
        'maka-proxy/deepseek-v4-flash',
        '--effort',
        'max',
      ],
      ['pi', 'https://api.deepseek.com', root, '/usr/bin/true'],
    ]) {
      const { stdout } = await execFileAsync(process.execPath, [wrapper.pathname, ...args], {
        env,
      });
      assert.equal(JSON.parse(stdout).schemaVersion, 'maka.external_subject_result.v2');
    }
    const codexConfig = await readFile(join(root, 'tmp/maka-eval-codex/config.toml'), 'utf8');
    assert.match(codexConfig, /model_catalog_json = .*deepseek-codex-models\.json/u);
    assert.match(codexConfig, /model_reasoning_effort = "max"/u);
    assert.match(codexConfig, /supports_websockets = false/u);
    assert.match(
      await readFile(join(root, 'etc/claude-code/managed-settings.json'), 'utf8'),
      /WebSearch.*WebFetch/u,
    );
    assert.match(
      await readFile(join(root, 'tmp/maka-eval-reasonix/config.toml'), 'utf8'),
      /enabled = \["bash", "read_file", "write_file", "edit_file", "glob", "grep"\]/u,
    );
    const piConfig = JSON.parse(
      await readFile(join(root, 'tmp/maka-eval-pi/models.json'), 'utf8'),
    ) as {
      providers: {
        'maka-proxy': {
          api: string;
          baseUrl: string;
          models: Array<{
            id: string;
            thinkingLevelMap: Record<string, string | null>;
          }>;
        };
      };
    };
    assert.equal(piConfig.providers['maka-proxy'].api, 'openai-responses');
    assert.match(piConfig.providers['maka-proxy'].baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
    assert.deepEqual(piConfig.providers['maka-proxy'].models[0], {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: 'high',
        xhigh: null,
        max: 'max',
      },
      input: ['text'],
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      cost: {
        input: 0.145,
        output: 0.29,
        cacheRead: 0.0029,
        cacheWrite: 0.145,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('eight-arm spec adds Pi with the same pinned DeepSeek execution contract', async () => {
  const spec = JSON.parse(
    await readFile(
      new URL(
        '../../experiments/terminal-bench-2.1-deepseek-v4-flash-eight-arm.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    subjects: Array<{ id: string; config: { args?: string[]; webTools?: string } }>;
    execution: { maxConcurrentTaskGroups: number };
    executor: { config: { mounts: Array<{ target: string }> } };
  };
  assert.equal(spec.execution.maxConcurrentTaskGroups, 14);
  assert.deepEqual(
    spec.subjects.map(({ id }) => id),
    ['maka', 'codex', 'claude-code', 'reasonix', 'opencode', 'kimi-code', 'zcode', 'pi'],
  );
  assert.deepEqual(
    spec.executor.config.mounts.map(({ target }) => target),
    [
      '/opt/maka-agent',
      '/opt/maka-node-toolchain',
      '/opt/maka-codex-toolchain',
      '/opt/maka-claude-code-toolchain',
      '/opt/maka-reasonix-toolchain',
      '/opt/maka-opencode-toolchain',
      '/opt/maka-kimi-code-toolchain',
      '/opt/maka-zcode-toolchain',
      '/opt/maka-pi-toolchain',
    ],
  );
  const pi = spec.subjects.find(({ id }) => id === 'pi')!;
  const maka = spec.subjects.find(({ id }) => id === 'maka')!;
  const zcode = spec.subjects.find(({ id }) => id === 'zcode')!;
  assert.equal(maka.config.webTools, 'disabled');
  assert.deepEqual(
    zcode.config.args?.slice(
      zcode.config.args.indexOf('--disallowedTools'),
      zcode.config.args.indexOf('--disallowedTools') + 2,
    ),
    ['--disallowedTools', 'WebSearch,WebFetch'],
  );
  assert.equal(pi.config.args?.includes('/opt/maka-pi-toolchain/bin/pi'), true);
  assert.equal(pi.config.args?.includes('--mode'), true);
  assert.equal(pi.config.args?.includes('json'), true);
  assert.equal(pi.config.args?.includes('--no-session'), true);
  assert.equal(pi.config.args?.includes('--thinking'), true);
  assert.equal(pi.config.args?.includes('max'), true);
});

test('Maka web-tool policy removes both hosted search and fetch surfaces', () => {
  const document = disabledWebToolsRuntimePolicyDocument();
  assert.equal(document.policy.webSearch.enabled, false);
  assert.equal(document.policy.privacy.incognitoActive, true);
});

async function verifyPreparationCancellation(
  stage: 'connection' | 'ready',
  ignoreFirstTermination: boolean,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `maka-eval-${stage}-cancel-`));
  const executable = join(root, 'fake-python.mjs');
  const barrier = join(root, 'barrier');
  const pidPath = join(root, 'pid');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { connect } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
let terminations = 0;
process.on('SIGTERM', () => {
  terminations += 1;
  if (process.env.MAKA_TEST_IGNORE_FIRST !== '1' || terminations > 1) process.exit(0);
});
await writeFile(process.env.MAKA_TEST_PID, String(process.pid));
if (process.env.MAKA_TEST_STAGE === 'ready') {
  const config = JSON.parse(await readFile(process.argv.at(-1), 'utf8'));
  const socket = connect(config.agent.kwargs.relay_port, config.agent.kwargs.relay_host);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}
await writeFile(process.env.MAKA_TEST_BARRIER, '');
setInterval(() => {}, 1_000);
await new Promise(() => {});
`,
  );
  await chmod(executable, 0o755);
  const restore = setEnvironment({
    MAKA_TEST_PYTHON: executable,
    MAKA_TEST_TRIALS: root,
    MAKA_TEST_BARRIER: barrier,
    MAKA_TEST_PID: pidPath,
    MAKA_TEST_STAGE: stage,
    MAKA_TEST_IGNORE_FIRST: ignoreFirstTermination ? '1' : '0',
  });
  try {
    const controller = new AbortController();
    const store = new FileAttemptStore(join(root, 'attempts'));
    const running = runExperiment({
      spec: experiment(),
      store,
      executor: createHarborExecutor(executorConfig(), join(root, 'experiment.json')),
      subjects: [
        {
          kind: 'external',
          execute: async () => assert.fail('cancelled preparation must not run the subject'),
        },
      ],
      signal: controller.signal,
    });
    await waitForFile(barrier);
    const pid = Number(await readFile(pidPath, 'utf8'));
    controller.abort(new Error('test cancellation'));
    await running;

    const attempt = (await store.list('task::1::external'))[0]!;
    assert.equal(attempt.result.status, 'indeterminate');
    assert.equal(attempt.result.failureReason, 'executor preparation cancelled');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await store.runExclusive(async () => undefined);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

async function executeMaka(
  termination: 'framework_timeout' | 'cancelled',
  stdout: (executionId: string) => string,
) {
  return createMakaSubjectAdapter().execute({
    cell: cell('maka', makaConfig()),
    context: {
      cwd: '/app',
      taskInput: 'solve',
      metadata: {},
      execute: async (input: Parameters<SubjectExecutionContext['execute']>[0]) => {
        const payload = JSON.parse(Buffer.from(input.args[1] ?? '', 'base64url').toString()) as {
          execution: { executionId: string };
        };
        return {
          termination,
          exitCode: termination === 'framework_timeout' ? 124 : 130,
          stdout: stdout(payload.execution.executionId),
        };
      },
    },
  });
}

function experiment(): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1' as const,
    id: 'experiment',
    benchmark: { id: 'benchmark', version: TEST_REVISION, config: { repository: 'repo' } },
    executor: { kind: 'harbor', config: executorConfig() },
    execution: { maxConcurrentTaskGroups: 1 },
    subjects: [{ id: 'external', kind: 'external' as const, credentials: [], config: {} }],
    tasks: [{ id: 'task', input: 'solve', config: { harbor: { path: 'tasks/task' } } }],
    repetitions: 1,
    budget: { timeoutMultiplier: 1 },
    verifier: { reward: 'reward' },
  };
}

function executorConfig(): JsonObject {
  return {
    frameworkVersion: '0.20.0',
    pythonPathEnv: 'MAKA_TEST_PYTHON',
    trialsRootEnv: 'MAKA_TEST_TRIALS',
    containerCwd: '/app',
    environment: {},
    preparationEnvironment: [
      'MAKA_TEST_BARRIER',
      'MAKA_TEST_PID',
      'MAKA_TEST_STAGE',
      'MAKA_TEST_IGNORE_FIRST',
    ],
    mounts: [],
  };
}

function cell(kind: 'maka' | 'external', config: JsonObject): ExperimentCell {
  return {
    id: `task::1::${kind}`,
    experimentId: 'experiment',
    benchmark: { id: 'benchmark', version: TEST_REVISION, config: {} },
    executor: { kind: 'harbor', config: {} },
    subject: { id: kind, kind, credentials: [], config },
    task: { id: 'task', input: 'solve', config: {} },
    repetition: 1,
    budget: { maxSteps: 100 },
    verifier: {},
  };
}

function makaConfig() {
  return {
    nodePath: '/opt/node/bin/node',
    shimPath: '/opt/maka/harbor-maka-subject.js',
    runtimeHostsPath: '/tmp/maka-runtime-hosts',
    baseUrl: 'https://provider.test/v1',
    webTools: 'disabled',
    connectionSlug: 'provider',
    model: 'deepseek-v4-flash',
    thinkingLevel: 'max',
    permissionMode: 'bypass',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}

function usage() {
  return {
    inputTokens: 11,
    outputTokens: 7,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    reasoningTokens: 1,
    totalTokens: 18,
  };
}

function setEnvironment(values: Record<string, string>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await readFile(path);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
}
