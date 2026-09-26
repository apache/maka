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
import { test } from 'node:test';
import { createExternalSubjectAdapter } from '../external-subject.js';
import { expandExperiment, type ExperimentSpec } from '../experiment.js';
import { createFleetGroupExecution } from '../fleet-execution.js';
import { FleetCoordinator, MemoryFleetPersistence } from '../fleet-store.js';
import { FleetWorker, type FleetCellOutput } from '../fleet-worker.js';
import { type FleetWork, validateFleetReport } from '../fleet.js';
import {
  executeExperimentCell,
  runExperiment,
  type ExperimentExecutor,
  type SubjectAdapter,
} from '../runner.js';
import type { CellAttempt } from '../result.js';

function spec(): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'shared',
    benchmark: { id: 'mock', version: '1', config: {} },
    executor: { kind: 'mock-harness', config: {} },
    execution: { maxConcurrentTaskGroups: 1 },
    subjects: ['fast', 'slow'].map((id) => ({
      id,
      kind: 'external',
      credentials: [],
      config: { command: 'existing-agent', args: ['{{task.input}}'], result: 'exit-code' },
    })),
    tasks: [{ id: 'task', input: 'solve', config: {} }],
    repetitions: 1,
    budget: {},
    verifier: {},
  };
}
function work(): FleetWork {
  return {
    assignment: {
      id: 'assignment',
      groupId: JSON.stringify(['task', 1]),
      workerId: 'vm',
      generation: 1,
      attemptIds: ['fast', 'slow'],
      status: 'active',
      expiresAt: 100,
    },
    cells: expandExperiment(spec()).map((cell, i) => ({
      cell,
      attemptId: i === 0 ? 'fast' : 'slow',
    })),
  };
}
function executor(mode = 'ok', events: string[] = []): ExperimentExecutor {
  return {
    kind: 'mock-harness',
    async runAttempt({ cell }, operation) {
      if (mode === 'not_started')
        return { kind: 'not_started', code: 'preparation-failed', artifacts: [] };
      const result = await operation({
        context: {
          cwd: '/task',
          taskInput: cell.task.input,
          metadata: {},
          async execute(input) {
            events.push(`execute:${cell.subject.id}`);
            assert.equal(input.command, 'existing-agent');
            assert.deepEqual(input.args, ['solve']);
            if (mode === 'execute_throw') throw new Error('lost transport');
            return {
              termination: mode === 'timeout' ? 'framework_timeout' : 'exited',
              exitCode: 0,
              stdout: '',
            };
          },
        },
        async verify() {
          events.push(`verify:${cell.subject.id}`);
          if (mode === 'verify_throw') throw new Error('verifier unavailable');
          return {
            status: mode === 'verify_invalid' ? 'infra_failed' : 'completed',
            score: mode === 'verify_invalid' ? null : mode === 'timeout' ? 0 : 1,
            failureReason: null,
            artifacts: [],
          };
        },
      });
      events.push(`finalize:${cell.subject.id}`);
      if (mode === 'cleanup_unknown')
        return { kind: 'indeterminate', cause: 'cleanup-unconfirmed', value: result };
      if (mode === 'finalize_throw') throw new Error('finalization failed');
      return { kind: 'settled', value: result };
    },
  };
}

for (const [mode, execution, verification, cleanup, status] of [
  ['ok', 'completed', 'valid', 'confirmed', 'completed'],
  ['timeout', 'subject_failed', 'valid', 'confirmed', 'subject_failed'],
  ['not_started', 'not_started', 'not_run', 'unknown', 'infra_failed'],
  ['execute_throw', 'unknown', 'not_run', 'confirmed', 'infra_failed'],
  ['verify_throw', 'completed', 'invalid', 'confirmed', 'infra_failed'],
  ['verify_invalid', 'completed', 'invalid', 'confirmed', 'infra_failed'],
  ['cleanup_unknown', 'completed', 'invalid', 'unknown', 'indeterminate'],
  ['finalize_throw', 'completed', 'invalid', 'unknown', 'infra_failed'],
]) {
  test(`existing external adapter emits lifecycle evidence and preserves local results: ${mode}`, async () => {
    const experiment = spec();
    const cells = expandExperiment(experiment);
    const adapter = createExternalSubjectAdapter();
    const backend = executor(mode);
    const evidence = await executeExperimentCell(backend, adapter, cells[0], []);
    assert.equal(evidence.execution, execution);
    assert.equal(evidence.verification, verification);
    assert.equal(evidence.cleanup, cleanup);
    assert.equal(evidence.result.status, status);
    const attempts: CellAttempt[] = [];
    await runExperiment({
      spec: experiment,
      executor: backend,
      subjects: [adapter],
      cellIds: [cells[0].id],
      store: {
        list: async (id) => attempts.filter((a) => a.cellId === id),
        append: async (a) => {
          attempts.push(a);
        },
        runExclusive: async (fn) => fn(),
      },
    });
    const { durationMs: _one, ...actual } = evidence.result;
    const { durationMs: _two, ...local } = attempts[0].result;
    assert.deepEqual(actual, local);
    const output: FleetCellOutput[] = [];
    const execute = await createFleetGroupExecution({
      spec: experiment,
      executor: backend,
      subjects: [adapter],
      preflight: async () => {},
      collectArtifacts: async () => [],
    });
    await execute(work(), (_id, value) => {
      output.push(value);
    });
    assert.equal(output.length, 2);
    assert.equal(output[0].report.execution, execution);
    assert.equal(output[0].report.verification, verification);
    validateFleetReport({ ...output[0].report, artifacts: [] });
  });
}

test('real external adapter reaches coordinator commits via shared lifecycle with missing usage', async () => {
  const experiment = spec();
  const events: string[] = [];
  const coordinator = await FleetCoordinator.open({
    persistence: new MemoryFleetPersistence(),
    spec: experiment,
    policy: {
      runId: 'integration',
      environmentId: 'manifest',
      groupCpus: 1,
      groupMemoryMb: 1,
      leaseMs: 100,
      recoveryGraceMs: 100,
      retryBackoffMs: 0,
      maxAttemptsPerCell: 2,
    },
    now: () => 0,
  });
  const execution = await createFleetGroupExecution({
    spec: experiment,
    executor: executor('ok', events),
    subjects: [createExternalSubjectAdapter()],
    preflight: async () => {
      events.push('preflight');
    },
    collectArtifacts: async (_cell, result) => {
      assert.equal(result.artifacts[0].kind, 'external_process');
      return [new TextEncoder().encode(JSON.stringify(result.artifacts))];
    },
  });
  const vm = new FleetWorker(
    { id: 'vm', environmentId: 'manifest', cpus: 1, memoryMb: 1, groupSlots: 1 },
    coordinator,
    execution,
  );
  for (let i = 0; i < 12; i++) await vm.poll();
  const state = await coordinator.snapshot();
  assert.equal(events[0], 'preflight');
  assert.equal(events.filter((e) => e.startsWith('execute:')).length, 2);
  assert.equal(state.assignments.length, 1);
  assert.equal(state.assignments[0].status, 'finished');
  for (const attempt of state.attempts) {
    assert.equal(attempt.disposition, 'selected');
    assert.equal(attempt.report?.usage, 'missing');
    assert.equal(attempt.report?.artifacts.length, 1);
    await coordinator.persistence.getArtifact(attempt.report!.artifacts[0]);
  }
  await coordinator.close();
});

test('preflight or adapter admission fails before any execution', async () => {
  let executions = 0;
  const backend = executor();
  const input = {
    spec: spec(),
    executor: backend,
    subjects: [createExternalSubjectAdapter()],
    collectArtifacts: async () => [],
    preflight: async () => {
      throw new Error('verifier requires 6 CPUs');
    },
  };
  await assert.rejects(createFleetGroupExecution(input), /6 CPUs/);
  const bad = { ...spec(), subjects: [{ ...spec().subjects[0], config: { command: 'x' } }] };
  await assert.rejects(
    createFleetGroupExecution({ ...input, spec: bad, preflight: async () => {} }),
  );
  const prepared: SubjectAdapter = {
    kind: 'external',
    prepare: async () => {
      throw new Error('bad toolchain');
    },
    execute: async () => {
      executions++;
      throw new Error('should not run');
    },
  };
  await assert.rejects(
    createFleetGroupExecution({ ...input, subjects: [prepared], preflight: async () => {} }),
    /bad toolchain/,
  );
  assert.equal(executions, 0);
});

test('group emits completed cells before a sibling settles and prepares adapters only once', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fastEmitted!: () => void;
  const fast = new Promise<void>((resolve) => {
    fastEmitted = resolve;
  });
  let prepares = 0;
  const original = createExternalSubjectAdapter();
  const adapter: SubjectAdapter = {
    ...original,
    prepare: async (input) => {
      prepares++;
      await original.prepare?.(input);
    },
    execute: async (input) => {
      if (input.cell.subject.id === 'slow') await gate;
      return original.execute(input);
    },
  };
  const execute = await createFleetGroupExecution({
    spec: spec(),
    executor: executor(),
    subjects: [adapter],
    preflight: async () => {},
    collectArtifacts: async () => [],
  });
  const emitted: string[] = [];
  const running = execute(work(), (id) => {
    emitted.push(id);
    if (id === 'fast') fastEmitted();
  });
  await fast;
  assert.deepEqual(emitted, ['fast']);
  release();
  await running;
  assert.deepEqual(emitted, ['fast', 'slow']);
  assert.equal(prepares, 1);
});

test('artifact collection failure preserves measured evidence but blocks selection', async () => {
  const execute = await createFleetGroupExecution({
    spec: spec(),
    executor: executor(),
    subjects: [createExternalSubjectAdapter()],
    preflight: async () => {},
    collectArtifacts: async () => {
      throw new Error('disk unavailable');
    },
  });
  const reports: FleetCellOutput[] = [];
  await execute(work(), (_id, output) => {
    reports.push(output);
  });
  assert.equal(reports[0].report.execution, 'completed');
  assert.equal(reports[0].report.verification, 'valid');
  assert.match(reports[0].report.environmentFailure!, /disk unavailable/);
  validateFleetReport({ ...reports[0].report, artifacts: [] });
});

test('unpriced tokens retain unknown completeness without a model retry', async () => {
  const adapter: SubjectAdapter = {
    kind: 'external',
    execute: async () => ({
      status: 'completed',
      durationMs: 0,
      failureReason: null,
      artifacts: [],
      costUsd: null,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
      },
    }),
  };
  const execute = await createFleetGroupExecution({
    spec: spec(),
    executor: executor(),
    subjects: [adapter],
    preflight: async () => {},
    collectArtifacts: async () => [],
  });
  await execute(work(), (_id, output) => {
    assert.equal(output.report.usage, 'unknown');
    assert.equal(output.report.verification, 'valid');
    validateFleetReport({ ...output.report, artifacts: [] });
  });
});

test('verifier failure retries the cell through existing execution while preserving its completed sibling', async () => {
  const experiment = spec();
  const counts = new Map<string, number>();
  const backend: ExperimentExecutor = {
    kind: 'mock-harness',
    runAttempt: async (input, operation) => {
      const id = input.cell.subject.id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      return executor(id === 'slow' && count === 1 ? 'verify_invalid' : 'ok').runAttempt(
        input,
        operation,
      );
    },
  };
  const coordinator = await FleetCoordinator.open({
    persistence: new MemoryFleetPersistence(),
    spec: experiment,
    policy: {
      runId: 'retry-integration',
      environmentId: 'manifest',
      groupCpus: 1,
      groupMemoryMb: 1,
      leaseMs: 100,
      recoveryGraceMs: 100,
      retryBackoffMs: 0,
      maxAttemptsPerCell: 2,
    },
    now: () => 0,
  });
  const execute = await createFleetGroupExecution({
    spec: experiment,
    executor: backend,
    subjects: [createExternalSubjectAdapter()],
    preflight: async () => {},
    collectArtifacts: async () => [],
  });
  const vm = new FleetWorker(
    { id: 'vm', environmentId: 'manifest', cpus: 1, memoryMb: 1, groupSlots: 1 },
    coordinator,
    execute,
  );
  for (let i = 0; i < 24; i++) await vm.poll();
  const state = await coordinator.snapshot();
  assert.equal(counts.get('fast'), 1);
  assert.equal(counts.get('slow'), 2);
  assert.equal(state.assignments.length, 2);
  assert.equal(state.attempts.filter((a) => a.disposition === 'selected').length, 2);
  const failed = state.attempts.find((a) => a.disposition === 'retryable')!;
  assert.equal(failed.report?.execution, 'completed');
  assert.equal(failed.report?.verification, 'invalid');
  await coordinator.close();
});

test('rejects tampered or duplicate assigned cells before invoking the executor', async () => {
  const events: string[] = [];
  const execute = await createFleetGroupExecution({
    spec: spec(),
    executor: executor('ok', events),
    subjects: [createExternalSubjectAdapter()],
    preflight: async () => {},
    collectArtifacts: async () => [],
  });
  const invalid = work();
  invalid.cells[0].cell = {
    ...invalid.cells[0].cell,
    task: { ...invalid.cells[0].cell.task, input: 'changed' },
  };
  await assert.rejects(
    execute(invalid, () => {}),
    /prepared experiment/,
  );
  const duplicate = work();
  duplicate.cells[1] = { ...duplicate.cells[0], attemptId: 'slow' };
  await assert.rejects(
    execute(duplicate, () => {}),
    /prepared experiment/,
  );
  assert.deepEqual(events, []);
});
