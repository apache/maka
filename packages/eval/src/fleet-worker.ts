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

import type { FleetReport, FleetWork, FleetWorkerDescription } from './fleet.js';
import type { FleetTransport } from './fleet-store.js';

export interface FleetCellOutput {
  report: Omit<FleetReport, 'artifacts'>;
  artifacts: Uint8Array[];
}

/** Implemented by mock VMs for now. The callback reports cells before the group settles. */
export type FleetGroupExecution = (
  work: FleetWork,
  emit: (attemptId: string, output: FleetCellOutput) => void,
) => Promise<void>;

/**
 * Transport-independent worker loop. Its outbox survives disconnection, not process death.
 * The caller drives polling; no wall clock, timers, networking or cloud SDK is hidden here.
 */
export class FleetWorker {
  #runs = new Map<string, { work: FleetWork; settled: boolean; emitted: Set<string> }>();
  #outbox = new Map<string, FleetCellOutput>();
  #polling: Promise<void> | undefined;

  constructor(
    readonly description: FleetWorkerDescription,
    private readonly transport: FleetTransport,
    private readonly execute: FleetGroupExecution,
  ) {}

  poll(): Promise<void> {
    this.#polling ??= this.#poll().finally(() => {
      this.#polling = undefined;
    });
    return this.#polling;
  }

  get bufferedReports() {
    return this.#outbox.size;
  }
  get activeGroups() {
    return this.#runs.size;
  }

  async #poll() {
    await this.transport.command({ kind: 'register', worker: this.description });
    const heartbeat = await this.transport.command({
      kind: 'heartbeat',
      workerId: this.description.id,
      assignmentIds: [...this.#runs.keys()],
    });
    for (const work of heartbeat.work ?? []) this.#adopt(work);
    for (const [attemptId, output] of this.#outbox) {
      const artifacts = [];
      for (const bytes of output.artifacts) artifacts.push(await this.transport.putArtifact(bytes));
      await this.transport.command({
        kind: 'report',
        workerId: this.description.id,
        attemptId,
        report: { ...output.report, artifacts },
      });
      this.#outbox.delete(attemptId);
    }
    for (const [assignmentId, run] of this.#runs) {
      if (!run.settled || run.work.cells.some((cell) => this.#outbox.has(cell.attemptId))) continue;
      await this.transport.command({ kind: 'finish', workerId: this.description.id, assignmentId });
      this.#runs.delete(assignmentId);
    }
    while (this.#runs.size < this.description.groupSlots) {
      const reply = await this.transport.command({ kind: 'claim', workerId: this.description.id });
      if (!reply.assignment) break;
      for (const work of reply.work ?? []) this.#adopt(work);
    }
  }

  #adopt(work: FleetWork) {
    if (this.#runs.has(work.assignment.id)) return;
    const run = { work, settled: false, emitted: new Set<string>() };
    this.#runs.set(work.assignment.id, run);
    const emit = (attemptId: string, output: FleetCellOutput) => {
      if (!work.cells.some((cell) => cell.attemptId === attemptId) || run.emitted.has(attemptId)) {
        throw new Error('executor emitted an unknown or duplicate attempt');
      }
      run.emitted.add(attemptId);
      this.#outbox.set(attemptId, structuredClone(output));
    };
    // A failed local operation is an execution uncertainty, not a provider classification.
    void Promise.resolve()
      .then(() => this.execute(work, emit))
      .catch(() => undefined)
      .finally(() => {
        for (const cell of work.cells) {
          if (run.emitted.has(cell.attemptId)) continue;
          emit(cell.attemptId, {
            report: {
              result: {
                status: 'infra_failed',
                score: null,
                usage: null,
                costUsd: null,
                durationMs: 0,
                failureReason: 'worker execution ended without a cell report',
                artifacts: [],
              },
              execution: 'unknown',
              verification: 'not_run',
              usage: 'missing',
              cleanup: 'unknown',
              environmentFailure: null,
            },
            artifacts: [],
          });
        }
        run.settled = true;
      });
  }
}
