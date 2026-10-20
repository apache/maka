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

import { pathToFileURL } from 'node:url';
import type { ExperimentSpec } from './experiment.js';
import { summarizeFleet, type FleetPolicy, type FleetState } from './fleet.js';
import { FleetCoordinator, MemoryFleetPersistence, type FleetTransport } from './fleet-store.js';
import { FleetWorker, type FleetCellOutput } from './fleet-worker.js';

/** Replayable virtual-time fault simulation, exercising the real coordinator and worker loop. */
export async function simulateFleet(seed: number) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('seed must be uint32');
  let randomState = seed;
  const random = () => {
    randomState = (Math.imul(1664525, randomState) + 1013904223) >>> 0;
    return randomState;
  };
  const spec: ExperimentSpec = {
    schemaVersion: 'maka.eval.v1',
    id: 'fleet-simulation',
    benchmark: { id: 'mock-benchmark', version: '1', config: {} },
    executor: { kind: 'mock', config: {} },
    execution: { maxConcurrentTaskGroups: 3 },
    subjects: ['a', 'b', 'c'].map((id) => ({ id, kind: 'external', credentials: [], config: {} })),
    tasks: Array.from({ length: 20 }, (_, index) => ({
      id: `task-${index}`,
      input: 'mock',
      config: {},
    })),
    repetitions: 2,
    budget: {},
    verifier: {},
  };
  const policy: FleetPolicy = {
    runId: `seed-${seed}`,
    environmentId: 'mock-manifest-v1',
    groupCpus: 6,
    groupMemoryMb: 1024,
    leaseMs: 12,
    recoveryGraceMs: 15,
    retryBackoffMs: 2,
    maxAttemptsPerCell: 20,
  };
  let now = 0;
  const persistence = new MemoryFleetPersistence();
  let coordinator = await FleetCoordinator.open({ persistence, spec, policy, now: () => now });
  const trace: string[] = [];
  let order = 0;
  const events: { at: number; order: number; action: () => void }[] = [];
  let crashed = false;
  const lost = new Set<string>();
  const committed = new Map<string, string>();
  const workers = Array.from({ length: 3 }, (_, index) => {
    const id = `vm-${index}/boot-1`;
    const disconnected = () => (now >= 55 && now < 100) || (index === 0 && now >= 8 && now < 38);
    const transport: FleetTransport = {
      async command(command) {
        if (disconnected()) throw new SimulatedLinkError();
        const roll = random();
        if (now < 240 && roll % 31 === 0) {
          trace.push(`${now} ${id} ${command.kind} dropped-before`);
          throw new SimulatedLinkError();
        }
        const reply = await coordinator.command(command);
        const once = `${id}/${command.kind}`;
        // Guaranteed lost claim/report acknowledgements, plus seeded background faults.
        if (
          now < 240 &&
          ((['claim', 'report'].includes(command.kind) && !lost.has(once)) || roll % 37 === 0)
        ) {
          lost.add(once);
          trace.push(`${now} ${id} ${command.kind} dropped-after`);
          throw new SimulatedLinkError();
        }
        return reply;
      },
      async putArtifact(bytes) {
        if (disconnected()) throw new SimulatedLinkError();
        return coordinator.putArtifact(bytes);
      },
    };
    return new FleetWorker(
      {
        id,
        environmentId: policy.environmentId,
        cpus: 6,
        memoryMb: 1024,
        groupSlots: 1,
      },
      transport,
      (work, emit) =>
        new Promise<void>((resolve) => {
          trace.push(`${now} ${id} start ${work.assignment.id} cells=${work.cells.length}`);
          let remaining = work.cells.length;
          if (!remaining) {
            resolve();
            return;
          }
          for (const cell of work.cells) {
            const delay = 2 + (random() % 19);
            events.push({
              at: now + delay,
              order: order++,
              action: () => {
                if (index === 2 && crashed) return;
                const output = simulationOutput();
                // Valid outcomes with absent metering must remain selectable.
                if (random() % 5 === 0) {
                  output.report.usage = 'missing';
                  output.report.result = {
                    ...output.report.result,
                    usage: null,
                    costUsd: null,
                    status: 'indeterminate',
                  };
                }
                emit(cell.attemptId, output);
                trace.push(`${now} ${id} completed ${cell.attemptId}`);
                if (--remaining === 0) resolve();
              },
            });
          }
        }),
    );
  });
  for (now = 0; now < 3000; now++) {
    if (now === 20) {
      crashed = true;
      trace.push(`${now} vm-2 process-crash`);
    }
    if (now === 55) {
      await coordinator.command({ kind: 'pause' });
      trace.push(`${now} coordinator-offline`);
    }
    if (now === 100) {
      await coordinator.close();
      coordinator = await FleetCoordinator.open({ persistence, spec, policy, now: () => now });
      trace.push(`${now} coordinator-restarted`);
    }
    events.sort((a, b) => a.at - b.at || a.order - b.order);
    while (events[0]?.at <= now) events.shift()!.action();
    // Drain the finite execute/catch/finally chain, without timers or real sleeps.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    for (const [index, worker] of workers.entries()) {
      if (index === 2 && crashed) continue;
      try {
        await worker.poll();
      } catch (error) {
        if (!(error instanceof SimulatedLinkError)) throw error;
      }
    }
    await coordinator.command({ kind: 'tick' });
    const state = await coordinator.snapshot();
    try {
      assertFleetInvariants(state);
      for (const [id, evidence] of committed) {
        const attempt = state.attempts.find((a) => a.id === id);
        if (!attempt || JSON.stringify(attempt) !== evidence)
          throw new Error('committed result changed or disappeared');
      }
      for (const attempt of state.attempts) {
        if (attempt.disposition === 'selected') committed.set(attempt.id, JSON.stringify(attempt));
      }
    } catch (error) {
      throw new Error(
        `simulation invariant failed: seed=${seed} tick=${now}\n${trace.slice(-30).join('\n')}`,
        { cause: error },
      );
    }
    if (summarizeFleet(state).settled)
      return { seed, elapsedTicks: now, trace, state, summary: summarizeFleet(state) };
  }
  throw new Error(`simulation did not settle: seed=${seed}\n${trace.slice(-30).join('\n')}`);
}

/** Cross-cutting safety oracle, checked after every simulated tick. */
export function assertFleetInvariants(state: FleetState) {
  const fail = (message: string): never => {
    throw new Error(`fleet invariant: ${message}`);
  };
  const active = state.assignments.filter((a) => a.status === 'active');
  if (active.length > state.spec.execution.maxConcurrentTaskGroups) fail('global capacity');
  if (new Set(active.map((a) => a.groupId)).size !== active.length) fail('group ownership');
  for (const worker of state.workers) {
    if (
      active.filter((a) => a.workerId === worker.description.id).length >
      worker.description.groupSlots
    )
      fail('worker capacity');
  }
  for (const cellId of state.groups.flatMap((g) => g.cellIds)) {
    const attempts = state.attempts.filter((a) => a.cellId === cellId);
    if (attempts.filter((a) => a.disposition === 'selected').length > 1) fail('duplicate result');
    if (attempts.length > state.policy.maxAttemptsPerCell) fail('retry budget');
    if (attempts.some((a, i) => a.sequence !== i + 1)) fail('attempt ordering');
  }
  if (new Set(state.attempts.map((a) => a.id)).size !== state.attempts.length)
    fail('attempt identity');
  for (const assignment of state.assignments) {
    const group = state.groups.find((g) => g.id === assignment.groupId);
    if (
      !group ||
      assignment.attemptIds.some((id) => {
        const attempt = state.attempts.find((a) => a.id === id);
        return (
          !attempt ||
          attempt.assignmentId !== assignment.id ||
          !group.cellIds.includes(attempt.cellId)
        );
      })
    )
      fail('assignment membership');
  }
  for (const attempt of state.attempts.filter((a) => a.disposition === 'selected')) {
    if (
      !attempt.report ||
      attempt.report.verification !== 'valid' ||
      attempt.report.cleanup !== 'confirmed' ||
      attempt.report.environmentFailure !== null ||
      !['completed', 'subject_failed'].includes(attempt.report.execution)
    )
      fail('selected evidence');
  }
}

export function simulationOutput(): FleetCellOutput {
  return {
    report: {
      result: {
        status: 'completed',
        score: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 2,
        },
        costUsd: 0.01,
        durationMs: 1,
        failureReason: null,
        artifacts: [],
      },
      execution: 'completed',
      verification: 'valid',
      usage: 'complete',
      cleanup: 'confirmed',
      environmentFailure: null,
    },
    artifacts: [new TextEncoder().encode('mock subject artifact')],
  };
}

class SimulatedLinkError extends Error {}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const seed = Number(process.argv[2] ?? 1);
  const result = await simulateFleet(seed);
  process.stdout.write(
    `${JSON.stringify(
      { seed, elapsedTicks: result.elapsedTicks, ...result.summary, trace: result.trace },
      null,
      2,
    )}\n`,
  );
}
