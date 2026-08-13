import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExternalSubjectAdapter } from '../external-subject.js';
import type { ExperimentCell, ExperimentSpec } from '../experiment.js';
import type { CellAttempt } from '../result.js';
import { TOOLCHAIN_IDENTITIES, TOOLCHAIN_IDENTITY_ENV } from '../toolchain-verification.js';

test('passes declared environment and credential bindings to one external command', async () => {
  const cell = externalCell({
    command: '/opt/pi/bin/pi',
    args: ['--cwd', '{{task.cwd}}', '--print', '{{task.input}}'],
    environment: { PI_OFFLINE: '1' },
    credentialEnvironment: { DEEPSEEK_API_KEY: 'PROVIDER_KEY' },
    result: 'exit-code',
  });
  let request: unknown;

  const result = await createExternalSubjectAdapter().execute({
    cell,
    context: {
      cwd: '/app',
      taskInput: 'solve the task',
      metadata: {},
      execute: async (input) => {
        request = input;
        return { termination: 'exited', exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  assert.deepEqual(request, {
    command: '/opt/pi/bin/pi',
    args: ['--cwd', '/app', '--print', 'solve the task'],
    environment: { PI_OFFLINE: '1' },
    credentialEnvironment: { DEEPSEEK_API_KEY: 'PROVIDER_KEY' },
    captureStdout: false,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.usage, null);
  assert.equal(result.costUsd, null);
});

test('classifies missing executor process scope as infrastructure failure', async () => {
  const cell = externalCell({
    command: '/opt/pi/bin/pi',
    args: ['--print', '{{task.input}}'],
    credentialEnvironment: { DEEPSEEK_API_KEY: 'PROVIDER_KEY' },
    result: 'exit-code',
  });

  const result = await createExternalSubjectAdapter().execute({
    cell,
    context: {
      cwd: '/workspace',
      taskInput: 'solve',
      metadata: {},
      execute: async () => ({
        termination: 'exited',
        exitCode: 111,
        stdout: '',
        diagnostic: {
          category: 'execution-scope-unavailable',
          bytes: 0,
          sha256: createHash('sha256').update('').digest('hex'),
        },
      }),
    },
  });

  assert.equal(result.status, 'infra_failed');
  assert.equal(result.failureReason, 'external subject execution scope was unavailable');
});

test('requires the bundled wrapper for the structured result contract', () => {
  for (const args of [[], ['/tmp/harbor-external-subject.js', 'codex']]) {
    const cell = externalCell({ command: '/opt/tool', args });
    assert.throws(
      () => createExternalSubjectAdapter().validate?.(cell),
      /protocol-v1 requires the bundled result wrapper/u,
    );
  }
});

test('rejects credential bindings that the subject did not declare', () => {
  const cell = externalCell({
    command: '/opt/tool',
    args: [],
    credentialEnvironment: { DEEPSEEK_API_KEY: 'UNDECLARED_KEY' },
    result: 'exit-code',
  });

  assert.throws(
    () => createExternalSubjectAdapter().validate?.(cell),
    /credentialEnvironment\.DEEPSEEK_API_KEY must reference a declared credential/u,
  );
});

test('rejects overlap between public environment and credential targets', () => {
  const cell = externalCell({
    command: '/opt/tool',
    args: [],
    environment: { API_KEY: 'not-a-secret' },
    credentialEnvironment: { API_KEY: 'PROVIDER_KEY' },
    result: 'exit-code',
  });

  assert.throws(
    () => createExternalSubjectAdapter().validate?.(cell),
    /environment and credentialEnvironment overlap at API_KEY/u,
  );
});

test('rejects overlap with identity credential targets', () => {
  const cell = externalCell({
    command: '/opt/tool',
    args: [],
    environment: { PROVIDER_KEY: 'not-a-secret' },
    result: 'exit-code',
  });

  assert.throws(
    () => createExternalSubjectAdapter().validate?.(cell),
    /environment and credentialEnvironment overlap at PROVIDER_KEY/u,
  );
});

test('verifies a mounted toolchain once before cell execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-toolchain-'));
  const executable = join(root, 'bin/codex');
  const sourceEnv = 'MAKA_TEST_CODEX_TOOLCHAIN';
  const previous = process.env[sourceEnv];
  process.env[sourceEnv] = root;
  try {
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(executable, 'codex');
    const digest = createHash('sha256').update('codex').digest('hex');
    await writeFile(join(root, 'checksums.sha256'), `${digest}  bin/codex\n`);
    await writeFile(
      join(root, 'manifest.json'),
      `${JSON.stringify({ fingerprint: TOOLCHAIN_IDENTITIES.codex.fingerprint })}\n`,
    );
    const cell = {
      ...externalCell({
        command: '/opt/maka-node-toolchain/bin/node',
        args: [
          '/opt/maka-agent/packages/eval/dist/harbor-external-subject.js',
          'codex',
          'https://api.deepseek.com',
          '/',
          '/opt/maka-codex-toolchain/bin/codex',
        ],
      }),
      executor: {
        kind: 'harbor',
        config: {
          mounts: [
            {
              sourceEnv,
              target: TOOLCHAIN_IDENTITIES.codex.root,
              readOnly: true,
            },
          ],
        },
      },
    } satisfies ExperimentCell;
    const adapter = createExternalSubjectAdapter();
    await adapter.prepare?.({ spec: {} as ExperimentSpec, cells: [cell] });
    const attempt = toolchainAttempt(cell.id, TOOLCHAIN_IDENTITIES.codex.fingerprint);
    assert.equal(adapter.canReuse?.({ cell, attempt }), true);
    assert.equal(
      adapter.canReuse?.({ cell, attempt: toolchainAttempt(cell.id, 'sha256:stale') }),
      false,
    );
    await unlink(join(root, 'checksums.sha256'));
    let environment: Readonly<Record<string, string>> | undefined;

    await adapter.execute({
      cell,
      context: {
        cwd: '/app',
        taskInput: 'solve',
        metadata: {},
        execute: async (input) => {
          environment = input.environment;
          return {
            termination: 'exited',
            exitCode: 0,
            stdout: JSON.stringify({
              schemaVersion: 'maka.external_subject_result.v1',
              usage: null,
              costUsd: null,
              artifacts: [],
            }),
            stderr: '',
          };
        },
      },
    });

    assert.deepEqual(JSON.parse(environment?.[TOOLCHAIN_IDENTITY_ENV] ?? ''), {
      ...TOOLCHAIN_IDENTITIES.codex,
    });
  } finally {
    if (previous === undefined) delete process.env[sourceEnv];
    else process.env[sourceEnv] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

function toolchainAttempt(cellId: string, fingerprint: string): CellAttempt {
  return {
    cellId,
    sequence: 1,
    startedAt: 1,
    completedAt: 2,
    result: {
      score: 1,
      usage: null,
      costUsd: null,
      durationMs: 1,
      status: 'completed',
      failureReason: null,
      artifacts: [
        {
          kind: 'toolchain',
          profile: 'codex',
          version: TOOLCHAIN_IDENTITIES.codex.version,
          fingerprint,
        },
      ],
    },
  };
}

function externalCell(config: ExperimentCell['subject']['config']): ExperimentCell {
  return {
    id: 'task::1::external',
    experimentId: 'experiment',
    benchmark: { id: 'benchmark', version: '1', config: {} },
    executor: { kind: 'harbor', config: {} },
    subject: {
      id: 'external',
      kind: 'external',
      credentials: ['PROVIDER_KEY'],
      config,
    },
    task: { id: 'task', input: 'instruction', config: {} },
    repetition: 1,
    budget: { maxSteps: 100 },
    verifier: {},
  };
}
