import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExternalSubjectAdapter } from '../external-subject.js';
import type { ExperimentCell } from '../experiment.js';
import { createMakaSubjectAdapter } from '../maka-subject.js';

test('external subject delegates exactly one declared command to its executor', async () => {
  const cell = subjectCell('external', {
    command: '/opt/competitor',
    args: ['solve', '{{task.id}}', '{{task.input}}'],
  });
  let request: unknown;
  const result = await createExternalSubjectAdapter().execute({
    cell,
    context: {
      cwd: '/app',
      taskInput: 'official instruction',
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
    command: '/opt/competitor',
    args: ['solve', 'task', 'official instruction'],
    credentialNames: ['PROVIDER_KEY'],
  });
  assert.equal(result.status, 'completed');
});

test('Maka subject delegates one Hosted execution without owning Runtime lifecycle', async () => {
  const cell = subjectCell('maka', {
    nodePath: '/opt/node/bin/node',
    shimPath: '/opt/maka/harbor-maka-subject.js',
    runtimeHostsPath: '/tmp/maka-runtime-hosts',
    baseUrl: 'https://provider.test/v1',
    connectionSlug: 'provider',
    model: 'model',
    thinkingLevel: 'high',
    permissionMode: 'bypass',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  });
  let request: { readonly args: readonly string[] } | undefined;
  const result = await createMakaSubjectAdapter().execute({
    cell,
    context: {
      cwd: '/app',
      taskInput: 'official instruction',
      metadata: {},
      execute: async (input) => {
        request = input;
        const payload = JSON.parse(Buffer.from(input.args[1] ?? '', 'base64url').toString()) as {
          execution: {
            executionId: string;
            session: { workspace: { kind: string; path: string } };
            content: { text: string };
            maxSteps: number;
          };
        };
        assert.deepEqual(payload.execution.session.workspace, { kind: 'host_path', path: '/app' });
        assert.equal(payload.execution.content.text, 'official instruction');
        assert.equal(payload.execution.maxSteps, 100);
        return {
          termination: 'exited',
          exitCode: 0,
          stdout: JSON.stringify({
            executionId: payload.execution.executionId,
            kind: 'settled',
            status: 'completed',
            usage: zeroUsage(),
            costUsd: null,
          }),
        };
      },
    },
  });

  assert.equal(request?.args[0], '/opt/maka/harbor-maka-subject.js');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.artifacts, []);
});

test('framework timeout remains a verifiable failure for every subject kind', async () => {
  const cell = subjectCell('maka', {
    nodePath: '/opt/node/bin/node',
    shimPath: '/opt/maka/harbor-maka-subject.js',
    runtimeHostsPath: '/tmp/maka-runtime-hosts',
    baseUrl: 'https://provider.test/v1',
    connectionSlug: 'provider',
    model: 'model',
    thinkingLevel: 'high',
    permissionMode: 'bypass',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  });
  const makaResult = await createMakaSubjectAdapter().execute({
    cell,
    context: {
      cwd: '/app',
      taskInput: 'official instruction',
      metadata: {},
      execute: async (input) => {
        const payload = JSON.parse(Buffer.from(input.args[1] ?? '', 'base64url').toString()) as {
          execution: { executionId: string };
        };
        return {
          termination: 'framework_timeout' as const,
          exitCode: 124,
          stdout: JSON.stringify({
            executionId: payload.execution.executionId,
            kind: 'settled',
            status: 'cancelled',
            usage: zeroUsage(),
            costUsd: null,
          }),
        };
      },
    },
  });

  assert.equal(makaResult.status, 'failed');

  const externalResult = await createExternalSubjectAdapter().execute({
    cell: subjectCell('external', { command: '/opt/competitor', args: [] }),
    context: {
      cwd: '/app',
      taskInput: 'official instruction',
      metadata: {},
      execute: async () => ({ termination: 'framework_timeout', exitCode: 0, stdout: '' }),
    },
  });
  assert.equal(externalResult.status, 'failed');
});

function subjectCell(
  kind: 'maka' | 'external',
  config: ExperimentCell['subject']['config'],
): ExperimentCell {
  return {
    id: `task::1::${kind}`,
    experimentId: 'experiment',
    benchmark: { id: 'benchmark', version: '1', config: {} },
    executor: { kind: 'harbor', config: {} },
    subject: { id: kind, kind, credentials: ['PROVIDER_KEY'], config },
    task: { id: 'task', input: 'instruction', config: {} },
    repetition: 1,
    budget: { maxSteps: 100 },
    verifier: {},
  };
}

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}
