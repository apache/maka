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

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  isDeepResearchEvent,
  isDeepResearchScopeLevel,
  normalizeDeepResearchObjective,
  projectDeepResearchEvents,
  type DeepResearchArtifactRef,
  type DeepResearchChecklistItem,
  type DeepResearchChangedEvent,
  type DeepResearchCheckpoint,
  type DeepResearchEvent,
  type DeepResearchEventRefs,
  type DeepResearchHandoff,
  type DeepResearchMutationContext,
  type DeepResearchRun,
  type DeepResearchScopeLevel,
  type DeepResearchStep,
  type DeepResearchStore,
} from '@maka/core/deep-research-run';
import { assertSafeSessionId } from './session-store.js';
import { chainWrite } from './write-queue.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

export type { DeepResearchStore } from '@maka/core/deep-research-run';

export interface CreateDeepResearchStoreOptions {
  newId?: () => string;
  now?: () => number;
}

export interface SqliteDeepResearchStore extends DeepResearchStore {
  ready(): Promise<void>;
  purgeSessionState(sessionId: string): Promise<void>;
  close(): void;
}

export type CreateSqliteDeepResearchStoreOptions = CreateDeepResearchStoreOptions;

export function createSqliteDeepResearchStore(
  workspaceRoot: string,
  options: CreateSqliteDeepResearchStoreOptions = {},
): SqliteDeepResearchStore {
  return new SqliteDeepResearchStoreImpl(
    workspaceRoot,
    options.newId ?? randomUUID,
    options.now ?? Date.now,
  );
}

class SqliteDeepResearchStoreImpl implements SqliteDeepResearchStore {
  readonly #lease: OperationalStateDatabaseLease;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly subscribers = new Set<(event: DeepResearchChangedEvent) => void>();

  constructor(
    workspaceRoot: string,
    private readonly newId: () => string,
    private readonly now: () => number,
  ) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.#lease.close();
  }

  async read(sessionId: string): Promise<DeepResearchRun | undefined> {
    const events = await this.readEvents(sessionId);
    return this.project(events);
  }

  async readEvents(sessionId: string): Promise<DeepResearchEvent[]> {
    assertSafeSessionId(sessionId);
    return readSqliteDeepResearchEvents(this.#lease.database, sessionId);
  }

  async purgeSessionState(sessionId: string): Promise<void> {
    assertSafeSessionId(sessionId);
    await chainWrite(this.writeQueues, sessionId, async () => {
      this.#lease.transaction('write', () => {
        this.#lease.database
          .prepare('DELETE FROM workflow_deep_research_events WHERE session_id = ?')
          .run(sessionId);
      });
    });
  }

  subscribe(listener: (event: DeepResearchChangedEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async start(
    sessionId: string,
    objective: string,
    scopeLevel: DeepResearchScopeLevel,
    context: DeepResearchMutationContext = {},
  ): Promise<DeepResearchRun> {
    const normalized = normalizeDeepResearchObjective(objective);
    if (!normalized) throw new Error('Deep Research objective must be a non-empty bounded string');
    if (!isDeepResearchScopeLevel(scopeLevel)) throw new Error('Invalid Deep Research scope level');
    return this.mutate(
      sessionId,
      'research_started',
      context,
      (events) => {
        if (events.length > 0) throw new Error('Deep Research workspace is already initialized');
        const ts = this.now();
        return {
          eventId: this.newId(),
          type: 'research_started',
          sessionId,
          ts,
          objective: normalized,
          scopeLevel,
          ...refsFromContext(context),
        };
      },
      (event) =>
        event.type === 'research_started' &&
        event.objective === normalized &&
        event.scopeLevel === scopeLevel,
    );
  }

  async recordArtifact(
    sessionId: string,
    artifact: DeepResearchArtifactRef,
    context: DeepResearchMutationContext = {},
  ): Promise<DeepResearchRun> {
    return this.mutate(
      sessionId,
      'research_artifact_recorded',
      context,
      () => ({
        eventId: this.newId(),
        type: 'research_artifact_recorded',
        sessionId,
        ts: this.now(),
        artifact: {
          ...artifact,
          sourceArtifactIds: [...artifact.sourceArtifactIds],
        },
        ...refsFromContext(context),
      }),
      (event) =>
        event.type === 'research_artifact_recorded' && sameArtifact(event.artifact, artifact),
    );
  }

  async updateChecklist(
    sessionId: string,
    item: Omit<DeepResearchChecklistItem, 'title' | 'updatedAt'>,
    context: DeepResearchMutationContext = {},
  ): Promise<DeepResearchRun> {
    return this.mutate(
      sessionId,
      'research_checklist_updated',
      context,
      (events) => {
        const run = this.project(events);
        const current = run?.checklist.find((candidate) => candidate.itemId === item.itemId);
        if (!current) throw new Error(`Unknown Deep Research checklist item ${item.itemId}`);
        return {
          eventId: this.newId(),
          type: 'research_checklist_updated',
          sessionId,
          ts: this.now(),
          item: {
            ...item,
            title: current.title,
            evidenceArtifactIds: [...item.evidenceArtifactIds],
            updatedAt: this.now(),
          },
          ...refsFromContext(context),
        };
      },
      (event) =>
        event.type === 'research_checklist_updated' &&
        event.item.itemId === item.itemId &&
        event.item.status === item.status &&
        event.item.blockedReason === item.blockedReason &&
        sameStrings(event.item.evidenceArtifactIds, item.evidenceArtifactIds),
    );
  }

  async recordStep(
    sessionId: string,
    step: Omit<DeepResearchStep, 'stepId' | 'createdAt'>,
    context: DeepResearchMutationContext = {},
  ): Promise<DeepResearchRun> {
    return this.mutate(
      sessionId,
      'research_step_recorded',
      context,
      () => ({
        eventId: this.newId(),
        type: 'research_step_recorded',
        sessionId,
        ts: this.now(),
        step: {
          ...step,
          stepId: this.newId(),
          roots: [...step.roots],
          keywords: [...step.keywords],
          ignoredPaths: [...step.ignoredPaths],
          evidenceArtifactIds: [...step.evidenceArtifactIds],
          inspectedRefs: step.inspectedRefs.map((ref) => ({ ...ref })),
          workerRunIds: [...step.workerRunIds],
          createdAt: this.now(),
        },
        ...refsFromContext(context),
      }),
      (event) => event.type === 'research_step_recorded' && sameStep(event.step, step),
    );
  }

  async recordCheckpoint(
    sessionId: string,
    checkpoint: Omit<DeepResearchCheckpoint, 'checkpointId' | 'createdAt'>,
    context: DeepResearchMutationContext = {},
  ): Promise<DeepResearchRun> {
    return this.mutate(
      sessionId,
      'research_checkpoint_recorded',
      context,
      () => ({
        eventId: this.newId(),
        type: 'research_checkpoint_recorded',
        sessionId,
        ts: this.now(),
        checkpoint: {
          ...checkpoint,
          checkpointId: this.newId(),
          createdAt: this.now(),
          openQuestions: [...checkpoint.openQuestions],
          nextSteps: [...checkpoint.nextSteps],
          taskIds: [...checkpoint.taskIds],
          artifactIds: [...checkpoint.artifactIds],
        },
        ...refsFromContext(context),
      }),
      (event) =>
        event.type === 'research_checkpoint_recorded' &&
        sameCheckpoint(event.checkpoint, checkpoint),
    );
  }

  async complete(
    sessionId: string,
    reportArtifactId: string,
    handoff: DeepResearchHandoff,
    context: DeepResearchMutationContext = {},
  ): Promise<DeepResearchRun> {
    return this.mutate(
      sessionId,
      'research_completed',
      context,
      () => ({
        eventId: this.newId(),
        type: 'research_completed',
        sessionId,
        ts: this.now(),
        reportArtifactId,
        handoff: {
          ...handoff,
          implementationTasks: [...handoff.implementationTasks],
          recommendedIssues: [...handoff.recommendedIssues],
          recommendedPullRequests: [...handoff.recommendedPullRequests],
          verificationCommands: [...handoff.verificationCommands],
        },
        ...refsFromContext(context),
      }),
      (event) =>
        event.type === 'research_completed' &&
        event.reportArtifactId === reportArtifactId &&
        sameHandoff(event.handoff, handoff),
    );
  }

  private async mutate(
    sessionId: string,
    expectedType: DeepResearchEvent['type'],
    context: DeepResearchMutationContext,
    buildEvent: (events: readonly DeepResearchEvent[]) => DeepResearchEvent,
    replayMatches?: (event: DeepResearchEvent) => boolean,
  ): Promise<DeepResearchRun> {
    assertSafeSessionId(sessionId);
    let nextRun: DeepResearchRun | undefined;
    await chainWrite(this.writeQueues, sessionId, async () => {
      const current = await this.readEvents(sessionId);
      if (context.toolCallId) {
        const replay = current.find((event) => event.refs?.toolCallId === context.toolCallId);
        if (replay) {
          if (replay.type !== expectedType) {
            throw new Error(
              `Deep Research tool call ${context.toolCallId} was already used for ${replay.type}`,
            );
          }
          if (replayMatches && !replayMatches(replay)) {
            throw new Error(
              `Deep Research tool call ${context.toolCallId} was retried with different input`,
            );
          }
          nextRun = this.project(current);
          return;
        }
      }
      const event = buildEvent(current);
      if (!isDeepResearchEvent(event)) {
        throw new Error('Invalid Deep Research mutation event');
      }
      const next = projectDeepResearchEvents([...current, event]);
      if (next.diagnostics.length > 0 || !next.run) {
        throw new Error(
          `Deep Research mutation rejected: ${next.diagnostics.join('; ') || 'missing run projection'}`,
        );
      }
      await this.appendEvent(sessionId, event);
      nextRun = next.run;
      const changed = { sessionId, ts: event.ts };
      for (const subscriber of this.subscribers) {
        try {
          subscriber(changed);
        } catch {
          // Durable mutation success must not depend on a best-effort UI subscriber.
        }
      }
    });
    if (!nextRun) throw new Error('Deep Research mutation did not produce a run');
    return nextRun;
  }

  private project(events: readonly DeepResearchEvent[]): DeepResearchRun | undefined {
    const projection = projectDeepResearchEvents(events);
    if (projection.diagnostics.length > 0) {
      throw new Error(
        `Deep Research ledger projection failed: ${projection.diagnostics.join('; ')}`,
      );
    }
    return projection.run;
  }

  private async appendEvent(sessionId: string, event: DeepResearchEvent): Promise<void> {
    this.#lease.transaction('write', () => {
      insertDeepResearchEvent(this.#lease.database, sessionId, event);
    });
  }
}

function readSqliteDeepResearchEvents(
  database: DatabaseSync,
  sessionId: string,
): DeepResearchEvent[] {
  assertSafeSessionId(sessionId);
  const rows = database
    .prepare(`
      SELECT record_json
      FROM workflow_deep_research_events
      WHERE session_id = ?
      ORDER BY sequence
    `)
    .all(sessionId) as Array<{ record_json?: unknown }>;
  return rows.map((row, index) => {
    if (typeof row.record_json !== 'string') {
      throw new Error(`Invalid SQLite Deep Research event at sequence ${index}`);
    }
    const parsed = JSON.parse(row.record_json);
    if (!isDeepResearchEvent(parsed) || parsed.sessionId !== sessionId) {
      throw new Error(`Invalid SQLite Deep Research event at sequence ${index}`);
    }
    return parsed;
  });
}

function insertDeepResearchEvent(
  database: DatabaseSync,
  sessionId: string,
  event: DeepResearchEvent,
): void {
  const row = database
    .prepare(`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
      FROM workflow_deep_research_events
      WHERE session_id = ?
    `)
    .get(sessionId) as { sequence?: unknown };
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence)) {
    throw new Error('Invalid next Deep Research event sequence');
  }
  database
    .prepare(`
      INSERT INTO workflow_deep_research_events(
        session_id, sequence, event_id, record_json
      ) VALUES (?, ?, ?, ?)
    `)
    .run(sessionId, row.sequence, event.eventId, JSON.stringify(event));
}

function refsFromContext(context: DeepResearchMutationContext): { refs?: DeepResearchEventRefs } {
  const refs: DeepResearchEventRefs = {
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
  };
  return Object.keys(refs).length > 0 ? { refs } : {};
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameArtifact(left: DeepResearchArtifactRef, right: DeepResearchArtifactRef): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.role === right.role &&
    left.name === right.name &&
    left.summary === right.summary &&
    left.createdAt === right.createdAt &&
    left.locator === right.locator &&
    left.contentHash === right.contentHash &&
    left.reportSectionKey === right.reportSectionKey &&
    left.reportSectionStatus === right.reportSectionStatus &&
    sameStrings(left.sourceArtifactIds, right.sourceArtifactIds)
  );
}

function sameStep(
  left: DeepResearchStep,
  right: Omit<DeepResearchStep, 'stepId' | 'createdAt'>,
): boolean {
  return (
    left.kind === right.kind &&
    left.status === right.status &&
    left.objective === right.objective &&
    left.summary === right.summary &&
    left.stoppingCondition === right.stoppingCondition &&
    left.expectedEvidence === right.expectedEvidence &&
    left.blockedReason === right.blockedReason &&
    sameStrings(left.roots, right.roots) &&
    sameStrings(left.keywords, right.keywords) &&
    sameStrings(left.ignoredPaths, right.ignoredPaths) &&
    sameStrings(left.evidenceArtifactIds, right.evidenceArtifactIds) &&
    sameStrings(left.workerRunIds, right.workerRunIds) &&
    left.inspectedRefs.length === right.inspectedRefs.length &&
    left.inspectedRefs.every((ref, index) => {
      const candidate = right.inspectedRefs[index];
      return (
        candidate !== undefined &&
        ref.kind === candidate.kind &&
        ref.locator === candidate.locator &&
        ref.label === candidate.label &&
        ref.sourceArtifactId === candidate.sourceArtifactId
      );
    })
  );
}

function sameCheckpoint(
  left: DeepResearchCheckpoint,
  right: Omit<DeepResearchCheckpoint, 'checkpointId' | 'createdAt'>,
): boolean {
  return (
    left.round === right.round &&
    left.stage === right.stage &&
    left.status === right.status &&
    left.summary === right.summary &&
    sameStrings(left.openQuestions, right.openQuestions) &&
    sameStrings(left.nextSteps, right.nextSteps) &&
    sameStrings(left.taskIds, right.taskIds) &&
    sameStrings(left.artifactIds, right.artifactIds)
  );
}

function sameHandoff(left: DeepResearchHandoff, right: DeepResearchHandoff): boolean {
  return (
    left.artifactId === right.artifactId &&
    sameStrings(left.implementationTasks, right.implementationTasks) &&
    sameStrings(left.recommendedIssues, right.recommendedIssues) &&
    sameStrings(left.recommendedPullRequests, right.recommendedPullRequests) &&
    sameStrings(left.verificationCommands, right.verificationCommands)
  );
}
