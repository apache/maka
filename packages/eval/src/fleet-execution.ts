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

import { stableJsonStringify } from '@maka/core/canonical-json';
import { expandExperiment, type ExperimentCell, type ExperimentSpec } from './experiment.js';
import type { EvalResult } from './result.js';
import { parseExperimentSpec } from './spec.js';
import {
  executeExperimentCell,
  prepareExperimentExecution,
  type ExperimentExecutor,
  type SubjectAdapter,
} from './runner.js';
import type { FleetGroupExecution } from './fleet-worker.js';
import type { FleetReport } from './fleet.js';

/** Prepare once before registering a worker; never clear adapter preparation state per group. */
export async function createFleetGroupExecution(input: {
  spec: ExperimentSpec;
  executor: ExperimentExecutor;
  subjects: readonly SubjectAdapter[];
  /** Use the deployment's real preflight (e.g. HarnessExecutor.preflight) before admission. */
  preflight: () => Promise<void>;
  /** Explicit collection boundary: legacy artifact metadata is not a list of readable file paths. */
  collectArtifacts: (cell: ExperimentCell, result: EvalResult) => Promise<Uint8Array[]>;
  signal?: AbortSignal;
}): Promise<FleetGroupExecution> {
  const spec = parseExperimentSpec(input.spec);
  const cells = expandExperiment(spec);
  await input.preflight();
  await prepareExperimentExecution(spec, cells, input.executor, input.subjects);
  const subjects = new Map(input.subjects.map((subject) => [subject.kind, subject]));
  const credentialNames = [...new Set(spec.subjects.flatMap((subject) => subject.credentials))];
  const expected = new Map(cells.map((cell) => [cell.id, cell]));
  return async (work, emit) => {
    const seen = new Set<string>();
    const seenCells = new Set<string>();
    for (const item of work.cells) {
      const cell = expected.get(item.cell.id);
      if (
        !cell ||
        stableJsonStringify(cell) !== stableJsonStringify(item.cell) ||
        JSON.stringify([cell.task.id, cell.repetition]) !== work.assignment.groupId ||
        !work.assignment.attemptIds.includes(item.attemptId) ||
        seen.has(item.attemptId) ||
        seenCells.has(item.cell.id)
      ) {
        throw new Error('fleet assignment does not match prepared experiment');
      }
      seen.add(item.attemptId);
      seenCells.add(item.cell.id);
    }
    const operations = work.cells.map(async ({ cell, attemptId }) => {
      const outcome = await executeExperimentCell(
        input.executor,
        subjects.get(cell.subject.kind)!,
        cell,
        credentialNames,
        input.signal,
      );
      // Adapters retain ownership of metering. Token presence alone does not prove settlement.
      const usage: FleetReport['usage'] =
        outcome.result.usage === null
          ? 'missing'
          : outcome.result.costUsd !== null
            ? 'complete'
            : 'unknown';
      let artifacts: Uint8Array[] = [];
      let environmentFailure: string | null = null;
      try {
        artifacts = await input.collectArtifacts(cell, outcome.result);
      } catch (error) {
        // Preserve execution and metering evidence, but do not select a cell with failed artifact collection.
        environmentFailure = `artifact collection failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      emit(attemptId, { report: { ...outcome, usage, environmentFailure }, artifacts });
    });
    const settled = await Promise.allSettled(operations);
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  };
}
