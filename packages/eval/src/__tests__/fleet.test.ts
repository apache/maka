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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExperimentSpec } from '../experiment.js';
import {
  summarizeFleet,
  type FleetAssignment,
  type FleetPolicy,
  type FleetReport,
  type FleetState,
} from '../fleet.js';
import { simulateFleet, simulationOutput } from '../fleet-simulation.js';
import {
  FileFleetPersistence,
  FleetCoordinator,
  MemoryFleetPersistence,
  type FleetPersistence,
  type FleetTransport,
} from '../fleet-store.js';
import { FleetWorker } from '../fleet-worker.js';

function spec(tasks = 3, cap = 2): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'test',
    benchmark: { id: 'test', version: '1', config: {} },
    executor: { kind: 'mock', config: {} },
    execution: { maxConcurrentTaskGroups: cap },
    subjects: ['fast', 'slow'].map((id) => ({ id, kind: 'external', credentials: [], config: {} })),
    tasks: Array.from({ length: tasks }, (_, i) => ({
      id: `task-${i}`,
      input: 'solve',
      config: {},
    })),
    repetitions: 1,
    budget: {},
    verifier: {},
  };
}
const policy: FleetPolicy = {
  runId: 'test-run',
  environmentId: 'reviewed-manifest',
  groupCpus: 6,
  groupMemoryMb: 1024,
  leaseMs: 10,
  recoveryGraceMs: 20,
  retryBackoffMs: 2,
  maxAttemptsPerCell: 2,
};
function report(overrides: Partial<FleetReport> = {}): FleetReport {
  return { ...simulationOutput().report, artifacts: [], ...overrides };
}
function worker(id: string, slots = 1) {
  return {
    id,
    environmentId: policy.environmentId,
    cpus: 6 * slots,
    memoryMb: 1024 * slots,
    groupSlots: slots,
  };
}
async function fixture(
  tasks = 3,
  cap = 2,
  persistence: FleetPersistence = new MemoryFleetPersistence(),
) {
  let now = 0;
  const experiment = spec(tasks, cap);
  let coordinator = await FleetCoordinator.open({
    persistence,
    spec: experiment,
    policy,
    now: () => now,
  });
  return {
    get coordinator() {
      return coordinator;
    },
    persistence,
    time(value: number) {
      now = value;
    },
    async restart() {
      await coordinator.close();
      coordinator = await FleetCoordinator.open({
        persistence,
        spec: experiment,
        policy,
        now: () => now,
      });
    },
    async admit(id: string, slots = 1) {
      await coordinator.command({ kind: 'register', worker: worker(id, slots) });
      await coordinator.command({ kind: 'heartbeat', workerId: id, assignmentIds: [] });
    },
    async claim(id: string) {
      return (await coordinator.command({ kind: 'claim', workerId: id })).assignment;
    },
    async submit(assignment: FleetAssignment, index = 0, value = report()) {
      return coordinator.command({
        kind: 'report',
        workerId: assignment.workerId,
        attemptId: assignment.attemptIds[index],
        report: value,
      });
    },
    async finish(assignment: FleetAssignment) {
      return coordinator.command({
        kind: 'finish',
        workerId: assignment.workerId,
        assignmentId: assignment.id,
      });
    },
  };
}

test('atomic claims obey global and per-worker group capacity; a straggler holds only its group', async () => {
  const f = await fixture(4, 2);
  await f.admit('a');
  await f.admit('b');
  await f.admit('c');
  const claims = await Promise.all([f.claim('a'), f.claim('a'), f.claim('b'), f.claim('c')]);
  assert.equal(claims.filter(Boolean).length, 2);
  const a = claims[0]!;
  const b = claims[2]!;
  await f.submit(a);
  assert.equal(
    (await f.coordinator.snapshot()).attempts.filter((x) => x.disposition === 'selected').length,
    1,
  );
  await assert.rejects(f.finish(a), /all cell reports/);
  assert.equal(await f.claim('c'), undefined);
  await f.submit(b, 0);
  await f.submit(b, 1);
  await f.finish(b);
  const next = await f.claim('b');
  assert.ok(next);
  assert.notEqual(next.groupId, a.groupId);
  assert.equal(
    (await f.coordinator.snapshot()).assignments.find((x) => x.id === a.id)?.status,
    'active',
  );
});

test('expired groups skip committed zeroes, fence late results, and retain duplicate execution cost', async () => {
  const f = await fixture(1, 1);
  await f.admit('a');
  await f.admit('b');
  const first = (await f.claim('a'))!;
  const zero = report({
    execution: 'subject_failed',
    result: { ...report().result, status: 'subject_failed', score: 0 },
  });
  await f.submit(first, 0, zero);
  f.time(10);
  await f.coordinator.command({ kind: 'tick' });
  f.time(12);
  const replacement = (await f.claim('b'))!;
  assert.equal(replacement.generation, 2);
  assert.equal(replacement.attemptIds.length, 1);
  assert.equal((await f.submit(first, 1)).disposition, 'late');
  assert.equal((await f.submit(first, 1)).disposition, 'late');
  await f.submit(replacement);
  await f.finish(replacement);
  const state = await f.coordinator.snapshot();
  const summary = summarizeFleet(state);
  assert.equal(summary.completedCells, 2);
  assert.equal(summary.results.find((r) => r.cellId.endsWith('fast'))?.result.score, 0);
  assert.equal(
    summary.results.find((r) => r.cellId.endsWith('slow'))?.attemptId,
    replacement.attemptIds[0],
  );
  assert.equal(summary.observedCostUsd, 0.03);
  await assert.rejects(f.submit(first, 1, zero), /conflicting/);
});

test('coordinator restart grants reconciliation grace before expiring old ownership', async () => {
  const f = await fixture(1, 1);
  await f.admit('a');
  await f.admit('b');
  const first = (await f.claim('a'))!;
  f.time(1000);
  await f.restart();
  assert.equal(await f.claim('b'), undefined);
  const recovery = await f.coordinator.command({
    kind: 'heartbeat',
    workerId: 'a',
    assignmentIds: [first.id],
  });
  assert.deepEqual(recovery.activeAssignmentIds, [first.id]);
  await f.submit(first, 0);
  await f.submit(first, 1);
  await f.finish(first);
  assert.equal(summarizeFleet(await f.coordinator.snapshot()).completedCells, 2);
  assert.equal((await f.coordinator.snapshot()).assignments.length, 1);
});

test('workers that never reconcile expire after the recovery grace', async () => {
  const f = await fixture(1, 1);
  await f.admit('a');
  await f.admit('b');
  await f.claim('a');
  f.time(1000);
  await f.restart();
  await f.coordinator.command({ kind: 'heartbeat', workerId: 'b', assignmentIds: [] });
  f.time(1019);
  assert.equal(await f.claim('b'), undefined);
  f.time(1020);
  await f.coordinator.command({ kind: 'tick' });
  f.time(1022);
  assert.ok(await f.claim('b'));
});

test('deterministic environment failures block dispatch until repair; admission includes verifier capacity', async () => {
  const f = await fixture(2, 2);
  await assert.rejects(
    f.coordinator.command({ kind: 'register', worker: { ...worker('small'), cpus: 4 } }),
    /admission/,
  );
  await assert.rejects(
    f.coordinator.command({
      kind: 'register',
      worker: { ...worker('wrong'), environmentId: 'wrong' },
    }),
    /admission/,
  );
  await f.admit('a');
  await f.admit('b');
  const first = (await f.claim('a'))!;
  const failure = report({
    execution: 'not_started',
    verification: 'not_run',
    environmentFailure: 'verifier certificate missing',
    result: { ...report().result, status: 'infra_failed', score: null },
  });
  await f.submit(first, 0, failure);
  await f.submit(first, 1, failure);
  await f.finish(first);
  f.time(2);
  assert.equal(await f.claim('b'), undefined);
  await f.coordinator.command({ kind: 'repair', reason: 'verifier certificate missing' });
  assert.ok(await f.claim('b'));
});

test('retry exhaustion is incomplete evaluation, not a synthetic zero', async () => {
  const f = await fixture(1, 1);
  await f.admit('a');
  const failure = report({
    execution: 'unknown',
    verification: 'invalid',
    cleanup: 'unknown',
    result: { ...report().result, status: 'indeterminate', score: null },
  });
  for (const at of [0, 2]) {
    f.time(at);
    const assignment = (await f.claim('a'))!;
    await f.submit(assignment, 0, failure);
    await f.submit(assignment, 1, failure);
    await f.finish(assignment);
  }
  f.time(4);
  assert.equal(await f.claim('a'), undefined);
  const summary = summarizeFleet(await f.coordinator.snapshot());
  assert.equal(summary.exhaustedCells, 2);
  assert.equal(summary.incompleteCells, 2);
  assert.equal(summary.settled, true);
  assert.deepEqual(summary.results, []);
});

test('selection uses execution/verification/cleanup evidence independently of usage and coarse status', async () => {
  const f = await fixture(1, 1);
  await f.admit('a');
  const assignment = (await f.claim('a'))!;
  const missing = report({
    usage: 'missing',
    result: { ...report().result, status: 'indeterminate', usage: null, costUsd: null },
  });
  assert.equal((await f.submit(assignment, 0, missing)).disposition, 'selected');
  const uncertainCleanup = report({ cleanup: 'unknown' });
  assert.equal((await f.submit(assignment, 1, uncertainCleanup)).disposition, 'retryable');
  await f.finish(assignment);
  f.time(2);
  assert.equal((await f.claim('a'))?.attemptIds.length, 1);
  const summary = summarizeFleet(await f.coordinator.snapshot());
  assert.equal(summary.completedCells, 1);
  assert.equal(summary.usageComplete, false);
  assert.equal(summary.results[0].result.status, 'completed');
  assert.equal((await f.coordinator.snapshot()).attempts[0].report?.result.status, 'indeterminate');
});

test('invalid evidence and foreign reports cannot change durable progress', async () => {
  const f = await fixture(1, 1);
  await f.admit('a');
  await f.admit('b');
  const assignment = (await f.claim('a'))!;
  const before = await f.coordinator.snapshot();
  await assert.rejects(
    f.submit(assignment, 0, report({ execution: 'unknown' })),
    /verification evidence/,
  );
  await assert.rejects(
    f.coordinator.command({
      kind: 'report',
      workerId: 'b',
      attemptId: assignment.attemptIds[0],
      report: report(),
    }),
    /foreign/,
  );
  await assert.rejects(f.submit(assignment, 0, report({ usage: 'missing' })), /missing usage/);
  assert.deepEqual(await f.coordinator.snapshot(), before);
});

test('lost claim and report acknowledgements recover through the real worker outbox', async () => {
  const f = await fixture(1, 1);
  const lost = new Set<string>();
  let executions = 0;
  const transport: FleetTransport = {
    async command(command) {
      const reply = await f.coordinator.command(command);
      if (['claim', 'report', 'finish'].includes(command.kind) && !lost.has(command.kind)) {
        lost.add(command.kind);
        throw new Error('reply lost');
      }
      return reply;
    },
    putArtifact: (bytes) => f.coordinator.putArtifact(bytes),
  };
  const vm = new FleetWorker(worker('a'), transport, async (work, emit) => {
    executions++;
    for (const cell of work.cells) emit(cell.attemptId, simulationOutput());
  });
  for (let i = 0; i < 10; i++) {
    try {
      await vm.poll();
    } catch (error) {
      assert.match(String(error), /reply lost/);
    }
  }
  assert.equal(executions, 1);
  assert.equal(vm.bufferedReports, 0);
  assert.equal(vm.activeGroups, 0);
  const state = await f.coordinator.snapshot();
  assert.equal(state.assignments.length, 1);
  assert.equal(summarizeFleet(state).completedCells, 2);
  for (const attempt of state.attempts) assert.equal(attempt.report?.artifacts.length, 1);
});

test('worker buffers completed cells during coordinator outage and resumes without reexecution', async () => {
  const f = await fixture(1, 1);
  let offline = false;
  let executions = 0;
  let complete = () => {};
  const vm = new FleetWorker(
    worker('a'),
    {
      command: (command) =>
        offline ? Promise.reject(new Error('offline')) : f.coordinator.command(command),
      putArtifact: (bytes) =>
        offline ? Promise.reject(new Error('offline')) : f.coordinator.putArtifact(bytes),
    },
    (work, emit) =>
      new Promise<void>((resolve) => {
        executions++;
        complete = () => {
          for (const cell of work.cells) emit(cell.attemptId, simulationOutput());
          resolve();
        };
      }),
  );
  await vm.poll();
  offline = true;
  complete();
  await assert.rejects(vm.poll(), /offline/);
  assert.equal(vm.bufferedReports, 2);
  f.time(1000);
  await f.restart();
  offline = false;
  await vm.poll();
  await vm.poll();
  assert.equal(executions, 1);
  assert.equal(summarizeFleet(await f.coordinator.snapshot()).completedCells, 2);
});

test('persistence failures before and after commit never expose uncommitted work or lose committed ownership', async () => {
  class FaultStore extends MemoryFleetPersistence {
    fault: 'before' | 'after' | null = null;
    override async save(state: FleetState) {
      const fault = this.fault;
      this.fault = null;
      if (fault === 'before') throw new Error('disk failed before commit');
      await super.save(state);
      if (fault === 'after') throw new Error('disk acknowledgement lost');
    }
  }
  const store = new FaultStore();
  const f = await fixture(1, 1, store);
  await f.admit('a');
  store.fault = 'before';
  await assert.rejects(f.claim('a'), /before commit/);
  assert.equal((await f.coordinator.snapshot()).assignments.length, 0);
  store.fault = 'after';
  await assert.rejects(f.claim('a'), /acknowledgement lost/);
  assert.equal((await f.coordinator.snapshot()).assignments.length, 1);
  await f.restart();
  const recovered = await f.coordinator.command({
    kind: 'heartbeat',
    workerId: 'a',
    assignmentIds: [],
  });
  assert.equal(recovered.work?.length, 1);
  assert.equal(await f.claim('a'), undefined);
});

test('file storage reopens committed state/artifacts, enforces one writer and rejects corruption', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-fleet-'));
  const stores: FileFleetPersistence[] = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const storage = await FileFleetPersistence.open(root);
  stores.push(storage);
  await assert.rejects(FileFleetPersistence.open(root), /EEXIST/);
  const f = await fixture(1, 1, storage);
  await f.admit('a');
  const assignment = (await f.claim('a'))!;
  const bytes = new TextEncoder().encode('durable trajectory');
  const ref = await storage.putArtifact(bytes);
  await f.submit(assignment, 0, report({ artifacts: [ref] }));
  await assert.rejects(
    f.submit(assignment, 1, report({ artifacts: [{ sha256: '0'.repeat(64), bytes: 1 }] })),
    /ENOENT/,
  );
  await f.coordinator.close();
  await storage.close();
  await assert.rejects(storage.load(), /closed/);
  const reopened = await FileFleetPersistence.open(root);
  stores.push(reopened);
  assert.deepEqual(new Uint8Array(await reopened.getArtifact(ref)), bytes);
  assert.equal((await reopened.load())?.attempts[0].disposition, 'selected');
  const recovered = await FleetCoordinator.open({
    persistence: reopened,
    spec: spec(1, 1),
    policy,
    now: () => 1000,
  });
  const heartbeat = await recovered.command({
    kind: 'heartbeat',
    workerId: 'a',
    assignmentIds: [assignment.id],
  });
  assert.equal(heartbeat.work?.[0].cells.length, 1);
  assert.equal(heartbeat.work?.[0].cells[0].attemptId, assignment.attemptIds[1]);
  await recovered.close();
  await assert.rejects(
    FleetCoordinator.open({
      persistence: reopened,
      spec: spec(1, 1),
      policy: { ...policy, runId: 'other' },
      now: () => 0,
    }),
    /identity differs/,
  );
  await writeFile(join(root, 'artifacts', ref.sha256), 'corrupt');
  await assert.rejects(reopened.getArtifact(ref), /checksum/);
  const path = join(root, 'state.json');
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.state.nextAssignment = 999;
  await writeFile(path, JSON.stringify(envelope));
  await assert.rejects(reopened.load(), /checksum/);
});

test('closing a coordinator drains accepted commands and rejects old-owner writes', async () => {
  const f = await fixture(1, 1);
  await f.admit('a');
  await assert.rejects(
    FleetCoordinator.open({ persistence: f.persistence, spec: spec(1, 1), policy, now: () => 0 }),
    /already has a coordinator/,
  );
  const claiming = f.claim('a');
  await f.coordinator.close();
  assert.ok(await claiming);
  await assert.rejects(f.claim('a'), /coordinator closed/);
  assert.equal((await f.persistence.load())?.assignments.length, 1);
});

test('explicit coordinator pause freezes leases and dispatch until recovery', async () => {
  const f = await fixture(2, 2);
  await f.admit('a');
  await f.admit('b');
  const assignment = (await f.claim('a'))!;
  await f.coordinator.command({ kind: 'pause' });
  f.time(1000);
  await f.coordinator.command({ kind: 'tick' });
  assert.equal(await f.claim('b'), undefined);
  assert.equal((await f.coordinator.snapshot()).assignments[0].status, 'active');
  await f.coordinator.command({ kind: 'recover' });
  await f.coordinator.command({ kind: 'heartbeat', workerId: 'a', assignmentIds: [assignment.id] });
  await f.submit(assignment, 0);
  await f.submit(assignment, 1);
  await f.finish(assignment);
  assert.equal((await f.coordinator.snapshot()).assignments.length, 1);
});

test('the same seed reproduces the entire fault trace and selected results byte for byte', async () => {
  const first = await simulateFleet(42);
  const second = await simulateFleet(42);
  assert.deepEqual(first, second);
  assert.ok(first.trace.some((line) => line.includes('dropped-before')));
  assert.ok(first.trace.some((line) => line.includes('report dropped-after')));
  assert.ok(first.state.attempts.some((a) => a.disposition === 'late'));
  assert.equal(first.summary.completedCells, 120);
});

for (let seed = 0; seed < 16; seed++) {
  test(`deterministic VM/network/restart simulation converges without duplicate selections: seed=${seed}`, async () => {
    const simulation = await simulateFleet(seed);
    assert.equal(simulation.summary.completedCells, 120);
    assert.equal(simulation.summary.exhaustedCells, 0);
    assert.equal(simulation.summary.settled, true);
  });
}
