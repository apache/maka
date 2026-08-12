import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExternalSubjectAdapter } from './external-subject.js';
import type { ExperimentCell } from './experiment.js';

test('passes declared environment and credential bindings to one external command', async () => {
  const cell = externalCell({
    command: '/opt/pi/bin/pi',
    args: ['--print', '{{task.input}}'],
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
        return { termination: 'exited', exitCode: 0, stdout: '' };
      },
    },
  });

  assert.deepEqual(request, {
    command: '/opt/pi/bin/pi',
    args: ['--print', 'solve the task'],
    credentialNames: ['PROVIDER_KEY'],
    environment: { PI_OFFLINE: '1' },
    credentialEnvironment: { DEEPSEEK_API_KEY: 'PROVIDER_KEY' },
    captureStdout: false,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.usage, null);
  assert.equal(result.costUsd, null);
});

test('keeps protocol-v1 as the default result contract', async () => {
  const cell = externalCell({ command: '/opt/tool', args: [] });
  let request: unknown;

  const result = await createExternalSubjectAdapter().execute({
    cell,
    context: {
      cwd: '/app',
      taskInput: 'solve the task',
      metadata: {},
      execute: async (input) => {
        request = input;
        return {
          termination: 'exited',
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 'maka.external_subject_result.v1',
            usage: null,
            costUsd: null,
            artifacts: [],
          }),
        };
      },
    },
  });

  assert.deepEqual(request, {
    command: '/opt/tool',
    args: [],
    credentialNames: ['PROVIDER_KEY'],
  });
  assert.equal(result.status, 'completed');
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
