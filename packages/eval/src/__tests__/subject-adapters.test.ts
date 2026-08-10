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
          execution: { session: { cwd: string }; content: { text: string }; maxSteps: number };
        };
        assert.equal(payload.execution.session.cwd, '/app');
        assert.equal(payload.execution.content.text, 'official instruction');
        assert.equal(payload.execution.maxSteps, 100);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            executionId: 'owned-by-runtime-host',
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
