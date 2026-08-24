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

import type { AgentRunStore } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import { isSessionInlineRun } from '@maka/core/agent-run';
import { loadLatestHistoryCompactCheckpointFromRunLedger } from './history-compact-ledger.js';
import {
  canReplaceHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';
import type { AgentRun } from './agent-run.js';

export interface HistoryCompactCleanupRequest {
  sessionId: string;
  checkpoint: HistoryCompactCheckpoint;
  runtimeEvents: readonly RuntimeEvent[];
}

interface HistoryCompactCheckpointCoordinatorDeps {
  runStore?: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  cleanupHistoryCompactArtifacts?: (input: HistoryCompactCleanupRequest) => Promise<void>;
}

export class HistoryCompactCheckpointCoordinator {
  private readonly checkpoints = new Map<string, HistoryCompactCheckpoint | undefined>();
  private readonly loads = new Map<string, Promise<HistoryCompactCheckpoint | undefined>>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly cleanups = new Map<string, Promise<void>>();

  constructor(private readonly deps: HistoryCompactCheckpointCoordinatorDeps) {}

  load(sessionId: string): Promise<HistoryCompactCheckpoint | undefined> {
    if (this.checkpoints.has(sessionId)) {
      return Promise.resolve(this.checkpoints.get(sessionId));
    }
    const existing = this.loads.get(sessionId);
    if (existing) return existing;
    if (!this.deps.runStore) return Promise.resolve(undefined);

    let guardedLoad: Promise<HistoryCompactCheckpoint | undefined>;
    guardedLoad = loadLatestHistoryCompactCheckpointFromRunLedger(this.deps.runStore, sessionId)
      .then((checkpoint) => {
        if (checkpoint) this.scheduleCleanup(sessionId, checkpoint);
        if (this.loads.get(sessionId) === guardedLoad && !this.checkpoints.has(sessionId)) {
          this.checkpoints.set(sessionId, checkpoint);
        }
        return this.checkpoints.has(sessionId) ? this.checkpoints.get(sessionId) : checkpoint;
      })
      .finally(() => {
        if (this.loads.get(sessionId) === guardedLoad) {
          this.loads.delete(sessionId);
        }
      });
    this.loads.set(sessionId, guardedLoad);
    return guardedLoad;
  }

  record(
    sessionId: string,
    checkpoint: HistoryCompactCheckpoint,
    run: AgentRun | undefined,
  ): Promise<void> {
    if (!run) return Promise.reject(new Error('No active AgentRun for history compact checkpoint'));
    const previous = this.writes.get(sessionId) ?? Promise.resolve();
    let tracked: Promise<void>;
    tracked = previous
      .catch(() => {})
      .then(async () => {
        const durableCheckpoint = await this.load(sessionId);
        if (!canReplaceHistoryCompactCheckpoint(durableCheckpoint, checkpoint)) {
          throw new Error('History compact checkpoint was superseded before persistence');
        }
        await run.recordHistoryCompactCheckpoint(checkpoint);
        this.checkpoints.set(sessionId, checkpoint);
        this.scheduleCleanup(sessionId, checkpoint);
      })
      .finally(() => {
        if (this.writes.get(sessionId) === tracked) {
          this.writes.delete(sessionId);
        }
      });
    this.writes.set(sessionId, tracked);
    return tracked;
  }

  clear(sessionId: string): void {
    this.checkpoints.delete(sessionId);
    this.loads.delete(sessionId);
  }

  private scheduleCleanup(sessionId: string, checkpoint: HistoryCompactCheckpoint): void {
    if (
      !this.deps.cleanupHistoryCompactArtifacts ||
      !this.deps.runStore ||
      !this.deps.runtimeEventStore
    )
      return;
    const previous = this.cleanups.get(sessionId) ?? Promise.resolve();
    let tracked: Promise<void>;
    tracked = previous
      .catch(() => {})
      .then(async () => {
        const runs = (await this.deps.runStore!.listSessionRuns(sessionId)).filter(
          isSessionInlineRun,
        );
        const runtimeEvents: RuntimeEvent[] = [];
        for (const run of runs) {
          runtimeEvents.push(
            ...(await this.deps.runtimeEventStore!.readRuntimeEvents(sessionId, run.runId)),
          );
        }
        await this.deps.cleanupHistoryCompactArtifacts!({
          sessionId,
          checkpoint,
          runtimeEvents,
        });
      })
      .catch(() => {
        // Legacy cleanup is reclaim-only. Runtime replay must remain available on failure.
      })
      .finally(() => {
        if (this.cleanups.get(sessionId) === tracked) {
          this.cleanups.delete(sessionId);
        }
      });
    this.cleanups.set(sessionId, tracked);
  }
}
