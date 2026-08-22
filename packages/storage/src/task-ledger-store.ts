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

import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  TASK_LEDGER_MAX_TASKS,
  TASK_ARCHIVE_AFTER_MS,
  findTaskByRef,
  isSafeTaskId,
  isTaskKey,
  isTaskOwner,
  isTerminalTaskStatus,
  isTaskLedgerEvent,
  normalizeUpdateTaskInput,
  normalizeCreateTaskInput,
  projectTaskLedgerEvents,
  taskLedgerEventTypeForCreate,
  taskLedgerEventTypeForUpdate,
  validateTaskUpdate,
  classifyTaskResumeTrust,
  type Task,
  type TaskAgentOutcome,
  type TaskAvailableClaimScope,
  type TaskLedgerChangedEvent,
  type TaskLedgerEvent,
  type TaskLedgerListOptions,
  type TaskLedgerMutationContext,
  type TaskLedgerStore,
  type TaskOwner,
} from '@maka/core/task-ledger';
import { chainWrite } from './write-queue.js';
import { assertSafeSessionId } from './session-store.js';
import { registerTaskLedgerCanonicalReader } from './task-ledger-store-internal.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

export type { TaskLedgerStore } from '@maka/core/task-ledger';

export interface ConversationTaskLedgerCopyInput {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly turnIds: readonly string[];
  readonly beforeTs?: number;
  readonly runIdMap: readonly {
    readonly sourceRunId: string;
    readonly targetRunId: string;
  }[];
}

export interface TaskLedgerAuthorityStore extends TaskLedgerStore {
  copyConversationTaskLedger(input: ConversationTaskLedgerCopyInput): Promise<void>;
  purgeConversationTaskLedger(sessionId: string): Promise<void>;
}

export interface SqliteTaskLedgerStore extends TaskLedgerAuthorityStore {
  ready(): Promise<void>;
  close(): void;
}

export function createSqliteTaskLedgerStore(workspaceRoot: string): SqliteTaskLedgerStore {
  return new SqliteTaskLedgerStoreImpl(workspaceRoot);
}

class SqliteTaskLedgerStoreImpl implements SqliteTaskLedgerStore {
  readonly #lease: OperationalStateDatabaseLease;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(event: TaskLedgerChangedEvent) => void>();

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
    registerTaskLedgerCanonicalReader(this, {
      list: (sessionId, options) => this.#listCanonical(sessionId, options),
      get: (sessionId, id, options) => this.#getCanonical(sessionId, id, options),
    });
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.#lease.close();
  }

  async list(sessionId: string, options: TaskLedgerListOptions = {}): Promise<Task[]> {
    assertSafeSessionId(sessionId);
    return this.applyListOptions(await this.readForRender(sessionId), options);
  }

  async get(
    sessionId: string,
    id: string,
    options: TaskLedgerListOptions = {},
  ): Promise<Task | undefined> {
    assertSafeSessionId(sessionId);
    if (!isSafeTaskId(id))
      throw new Error('Task id must be a stable token (alphanumeric plus . _ : -, max 64 chars)');
    const tasks = await this.list(sessionId, options);
    return findTaskByRef(tasks, id);
  }

  async #listCanonical(sessionId: string, options: TaskLedgerListOptions = {}): Promise<Task[]> {
    assertSafeSessionId(sessionId);
    const { tasks } = await this.readForMutateWithSource(sessionId);
    return this.applyListOptions(tasks, options);
  }

  async #getCanonical(
    sessionId: string,
    id: string,
    options: TaskLedgerListOptions = {},
  ): Promise<Task | undefined> {
    assertSafeSessionId(sessionId);
    if (!isSafeTaskId(id))
      throw new Error('Task id must be a stable token (alphanumeric plus . _ : -, max 64 chars)');
    return findTaskByRef(await this.#listCanonical(sessionId, options), id);
  }

  subscribe(listener: (event: TaskLedgerChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async copyConversationTaskLedger(input: ConversationTaskLedgerCopyInput): Promise<void> {
    assertSafeSessionId(input.sourceSessionId);
    assertSafeSessionId(input.targetSessionId);
    if (input.sourceSessionId === input.targetSessionId) {
      throw new Error('Task Ledger conversation copy requires distinct Sessions');
    }
    if (
      input.beforeTs !== undefined &&
      (!Number.isSafeInteger(input.beforeTs) || input.beforeTs < 0)
    ) {
      throw new Error('Task Ledger conversation-copy boundary is invalid');
    }
    const turnIds = new Set(input.turnIds);
    const runIds = new Map(
      input.runIdMap.map(({ sourceRunId, targetRunId }) => [sourceRunId, targetRunId]),
    );
    const source = await this.readConversationCopyEvents(input.sourceSessionId);
    const selected: TaskLedgerEvent[] = [];
    let crossedBoundary = false;
    for (const event of source) {
      const eventTurnId = event.refs?.turnId;
      const retained =
        eventTurnId !== undefined
          ? turnIds.has(eventTurnId)
          : input.beforeTs === undefined || event.ts < input.beforeTs;
      if (!retained) {
        crossedBoundary = true;
        continue;
      }
      if (crossedBoundary) {
        throw new Error('Task Ledger events cross the conversation-copy boundary');
      }
      selected.push(
        rewriteConversationTaskEvent(event, input.sourceSessionId, input.targetSessionId, runIds),
      );
    }
    if (selected.length === 0) return;
    const projection = projectTaskLedgerEvents(selected);
    if (projection.diagnostics.length > 0) {
      throw new Error(
        `Task Ledger conversation copy is not projectable: ${projection.diagnostics.join('; ')}`,
      );
    }

    await chainWrite(this.writeQueues, input.targetSessionId, async () => {
      this.copyConversationLedger(input.targetSessionId, selected, projection.tasks);
    });
  }

  async purgeConversationTaskLedger(sessionId: string): Promise<void> {
    assertSafeSessionId(sessionId);
    await chainWrite(this.writeQueues, sessionId, async () => {
      this.#lease.transaction('write', () => {
        this.#lease.database
          .prepare('DELETE FROM workflow_task_ledger_events WHERE session_id = ?')
          .run(sessionId);
        this.#lease.database
          .prepare('DELETE FROM workflow_task_ledger_projections WHERE session_id = ?')
          .run(sessionId);
      });
    });
  }

  async create(
    sessionId: string,
    drafts: unknown,
    context: TaskLedgerMutationContext = {},
  ): Promise<{ created: Task[]; total: number }> {
    assertSafeSessionId(sessionId);
    if (!Array.isArray(drafts) || drafts.length === 0) {
      throw new Error('Task creation requires at least one task draft');
    }
    // Front-door the per-batch cap before generating ids or normalizing drafts:
    // a single call can never add more than the absolute ledger cap, and rejecting
    // here avoids generating N uuids for a batch the write-queue total check
    // would refuse anyway. The total (existing + new) cap is still enforced
    // inside the serialized mutate callback below.
    if (drafts.length > TASK_LEDGER_MAX_TASKS) {
      throw new Error(
        `Task creation batch of ${drafts.length} tasks exceeds the ${TASK_LEDGER_MAX_TASKS}-task per-batch cap; split the work into smaller calls.`,
      );
    }
    const normalizedDrafts = drafts.map((draft) => {
      const normalized = normalizeCreateTaskInput(draft);
      if (!normalized.ok) throw new Error(normalized.message);
      return normalized.value;
    });
    const created: Task[] = [];
    // Cap check runs inside the serialized mutate callback (after reading the
    // current ledger) so concurrent creates cannot race past the limit, and a
    // rejected create never touches the file.
    const all = await this.mutate(
      sessionId,
      (tasks) => {
        if (tasks.length + normalizedDrafts.length > TASK_LEDGER_MAX_TASKS) {
          throw new Error(
            `Task ledger is limited to ${TASK_LEDGER_MAX_TASKS} tasks total per session ` +
              `(currently ${tasks.length}, adding ${normalizedDrafts.length}). This is a hard runaway guard on the ` +
              'total count — completed or cancelled tasks still count, so batch related work into fewer, ' +
              'coarser tasks instead.',
          );
        }
        const now = Date.now();
        for (const draft of normalizedDrafts) {
          const parent = draft.parentId ? findTaskByRef(tasks, draft.parentId) : undefined;
          if (draft.parentId && !parent) throw new Error(`No such parent task: ${draft.parentId}`);
          if (parent && isTerminalTaskStatus(parent.status)) {
            throw new Error(`Cannot create a child under terminal task ${parent.key}`);
          }
          const task: Task = {
            id: randomUUID(),
            key: nextTaskKey([...tasks, ...created], parent),
            subject: draft.subject,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
            ...(parent ? { parentId: parent.id } : {}),
            ...(ownerFromContext(context) ? { owner: ownerFromContext(context) } : {}),
          };
          created.push(task);
        }
        return [...tasks, ...created];
      },
      (next) =>
        created.map((task) =>
          buildTaskLedgerEvent({
            type: taskLedgerEventTypeForCreate(task),
            sessionId,
            task,
            context,
          }),
        ),
    );
    return { created, total: all.length };
  }

  async update(
    sessionId: string,
    id: string,
    patch: unknown,
    context: TaskLedgerMutationContext = {},
  ): Promise<{ updated: Task; total: number }> {
    assertSafeSessionId(sessionId);
    const now = Date.now();
    let updated: Task | undefined;
    let previous: Task | undefined;
    const all = await this.mutate(
      sessionId,
      (tasks) => {
        // Locate the target before producing a new list: an unknown id must
        // fail inside the callback without rewriting an identical file.
        const resolved = findTaskByRef(tasks, id);
        const index = resolved ? tasks.findIndex((task) => task.id === resolved.id) : -1;
        const current = index === -1 ? undefined : tasks[index];
        if (!current) throw new Error(`No such task: ${id}`);
        previous = current;
        const normalizedPatch = normalizeUpdateTaskInput(patch);
        if (!normalizedPatch.ok) throw new Error(normalizedPatch.message);
        const normalized = validateTaskUpdate(current, normalizedPatch.value, {
          explicitReopen: normalizedPatch.value.explicitReopen === true,
        });
        if (!normalized.ok) throw new Error(normalized.message);
        const { explicitReopen: _explicitReopen, ...taskPatch } = normalized.value;
        void _explicitReopen;
        updated = {
          ...current,
          ...(taskPatch.subject !== undefined ? { subject: taskPatch.subject } : {}),
          ...(taskPatch.status !== undefined ? { status: taskPatch.status } : {}),
          ...(taskPatch.blockedReason !== undefined
            ? { blockedReason: taskPatch.blockedReason }
            : {}),
          ...(taskPatch.failureReason !== undefined
            ? { failureReason: taskPatch.failureReason }
            : {}),
          ...(taskPatch.completionEvidence !== undefined
            ? { completionEvidence: taskPatch.completionEvidence }
            : {}),
          ...(taskPatch.status === 'in_progress' && context.actor === 'main_agent'
            ? { owner: ownerFromContext(context) }
            : {}),
          updatedAt: now,
        };
        if (taskPatch.status !== undefined && isTerminalTaskStatus(taskPatch.status)) {
          if (taskPatch.status === 'completed') assertDescendantsTerminal(tasks, current.id);
          updated.endedAt = now;
        } else if (taskPatch.status === 'pending' || taskPatch.status === 'in_progress') {
          delete updated.endedAt;
        }
        if (taskPatch.status === 'pending') delete updated.owner;
        updated = clearStaleTaskEvidence(updated);
        const next = [...tasks];
        next[index] = updated;
        return next;
      },
      () => {
        if (!previous || !updated) return [];
        return [
          buildTaskLedgerEvent({
            type: taskLedgerEventTypeForUpdate(previous, updated),
            sessionId,
            task: updated,
            previous,
            context,
          }),
        ];
      },
    );
    if (!updated) throw new Error(`No such task: ${id}`);
    return { updated, total: all.length };
  }

  async claim(
    sessionId: string,
    id: string,
    owner: TaskOwner,
    context: TaskLedgerMutationContext = {},
  ): Promise<{ updated: Task; total: number }> {
    assertSafeSessionId(sessionId);
    assertChildTaskOwner(owner);
    let updated: Task | undefined;
    let previous: Task | undefined;
    const all = await this.mutate(
      sessionId,
      (tasks) => {
        const current = findTaskByRef(tasks, id);
        if (!current) throw new Error(`No such task: ${id}`);
        if (isTerminalTaskStatus(current.status))
          throw new Error(`Cannot claim terminal task ${current.key}`);
        if (
          current.status === 'in_progress' &&
          current.owner?.actor === 'child_agent' &&
          current.owner.turnId !== owner.turnId
        ) {
          throw new Error(`Task ${current.key} is already claimed by another child agent`);
        }
        previous = current;
        updated = clearStaleTaskEvidence({
          ...current,
          status: 'in_progress',
          owner,
          updatedAt: Date.now(),
        });
        return tasks.map((task) => (task.id === current.id ? updated! : task));
      },
      () =>
        previous && updated
          ? [
              buildTaskLedgerEvent({
                type: taskLedgerEventTypeForUpdate(previous, updated),
                sessionId,
                task: updated,
                previous,
                context,
              }),
            ]
          : [],
    );
    if (!updated) throw new Error(`No such task: ${id}`);
    return { updated, total: all.length };
  }

  async claimAvailable(
    sessionId: string,
    id: string,
    owner: TaskOwner,
    scope: TaskAvailableClaimScope,
    context: TaskLedgerMutationContext = {},
  ): Promise<{ updated: Task; total: number }> {
    assertSafeSessionId(sessionId);
    assertChildTaskOwner(owner);
    if (!isSafeTaskId(scope.parentRunId))
      throw new Error('Available task claim requires a stable parent AgentRun id');
    let updated: Task | undefined;
    let previous: Task | undefined;
    const all = await this.mutate(
      sessionId,
      (tasks) => {
        const current = findTaskByRef(tasks, id);
        if (!current) throw new Error(`No such task: ${id}`);
        if (isTerminalTaskStatus(current.status))
          throw new Error(`Cannot claim terminal task ${current.key}`);

        const alreadyClaimed = tasks.find(
          (task) =>
            task.id !== current.id &&
            !isTerminalTaskStatus(task.status) &&
            task.owner?.actor === 'child_agent' &&
            task.owner.turnId === owner.turnId,
        );
        if (alreadyClaimed) {
          throw new Error(
            `Child agent already owns task ${alreadyClaimed.key}; one shared task may be claimed per child turn`,
          );
        }

        const sameOwner =
          current.owner?.actor === 'child_agent' && current.owner.turnId === owner.turnId;
        if (
          !sameOwner &&
          (current.owner?.actor !== 'main_agent' || current.owner.runId !== scope.parentRunId)
        ) {
          throw new Error(`Task ${current.key} is not shared by parent run ${scope.parentRunId}`);
        }
        if (current.status === 'in_progress' && !sameOwner) {
          throw new Error(
            `Task ${current.key} is already in progress and is not available for self-claim`,
          );
        }
        if (current.owner?.actor === 'child_agent' && !sameOwner) {
          throw new Error(`Task ${current.key} is already claimed by another child agent`);
        }

        previous = current;
        updated =
          sameOwner && current.status === 'in_progress'
            ? current
            : clearStaleTaskEvidence({
                ...current,
                status: 'in_progress',
                owner,
                updatedAt: Date.now(),
              });
        return updated === current
          ? tasks
          : tasks.map((task) => (task.id === current.id ? updated! : task));
      },
      () =>
        previous && updated && previous !== updated
          ? [
              buildTaskLedgerEvent({
                type: taskLedgerEventTypeForUpdate(previous, updated),
                sessionId,
                task: updated,
                previous,
                context,
              }),
            ]
          : [],
    );
    if (!updated) throw new Error(`No such task: ${id}`);
    return { updated, total: all.length };
  }

  async settleAgentOutcome(
    sessionId: string,
    id: string,
    outcome: TaskAgentOutcome,
    context: TaskLedgerMutationContext = {},
  ): Promise<{ updated: Task; total: number }> {
    assertSafeSessionId(sessionId);
    assertChildTaskOwner(outcome.owner);
    let updated: Task | undefined;
    let previous: Task | undefined;
    const all = await this.mutate(
      sessionId,
      (tasks) => {
        const current = findTaskByRef(tasks, id);
        if (!current) throw new Error(`No such task: ${id}`);
        if (
          current.owner?.actor === 'child_agent' &&
          current.owner.turnId &&
          current.owner.turnId !== outcome.owner.turnId
        ) {
          throw new Error(`Task ${current.key} is owned by a different child agent`);
        }
        previous = current;
        const now = Date.now();
        updated = { ...current, owner: outcome.owner, updatedAt: now };
        if (!isTerminalTaskStatus(current.status)) {
          if (outcome.status === 'failed') {
            updated.status = 'failed';
            updated.failureReason = normalizeOutcomeReason(outcome.reason, 'Child agent failed');
            updated.endedAt = now;
          } else if (outcome.status === 'cancelled') {
            updated.status = 'cancelled';
            updated.endedAt = now;
          } else if (outcome.status === 'waiting_for_user') {
            updated.status = 'blocked';
            updated.blockedReason = normalizeOutcomeReason(
              outcome.reason,
              'Child agent is waiting for user input',
            );
          }
        }
        updated = clearStaleTaskEvidence(updated);
        return tasks.map((task) => (task.id === current.id ? updated! : task));
      },
      () =>
        previous && updated
          ? [
              buildTaskLedgerEvent({
                type: taskLedgerEventTypeForUpdate(previous, updated),
                sessionId,
                task: updated,
                previous,
                context: { ...context, reason: outcome.reason ?? context.reason },
              }),
            ]
          : [],
    );
    if (!updated) throw new Error(`No such task: ${id}`);
    return { updated, total: all.length };
  }

  private async readForRender(sessionId: string): Promise<Task[]> {
    return (await this.readProjected(sessionId)).tasks;
  }

  private async readForMutateWithSource(sessionId: string): Promise<{ tasks: Task[] }> {
    return this.readProjected(sessionId);
  }

  private async readProjected(sessionId: string): Promise<{ tasks: Task[] }> {
    const events = await this.readTaskEvents(sessionId);
    const projection = projectTaskLedgerEvents(events);
    if (projection.diagnostics.length > 0) {
      throw new Error(
        `task event ledger has projection diagnostics: ${projection.diagnostics.join('; ')}`,
      );
    }
    if (projection.tasks.length > TASK_LEDGER_MAX_TASKS) {
      throw new Error(
        `task event ledger has ${projection.tasks.length} tasks, exceeding the ${TASK_LEDGER_MAX_TASKS}-task cap; refusing to load an unbounded ledger`,
      );
    }
    return { tasks: projection.tasks };
  }

  private async readTaskEvents(sessionId: string): Promise<TaskLedgerEvent[]> {
    return readSqliteTaskLedgerEvents(this.#lease.database, sessionId);
  }

  private async readConversationCopyEvents(sessionId: string): Promise<TaskLedgerEvent[]> {
    return this.readTaskEvents(sessionId);
  }

  private async mutate(
    sessionId: string,
    fn: (tasks: Task[]) => Task[],
    eventsForMutation: (next: Task[]) => TaskLedgerEvent[],
  ): Promise<Task[]> {
    let next: Task[] = [];
    await chainWrite(this.writeQueues, sessionId, async () => {
      const currentRead = await this.readForMutateWithSource(sessionId);
      const current = currentRead.tasks;
      next = fn(current);
      const mutationEvents = eventsForMutation(next);
      await this.appendEvents(sessionId, mutationEvents);
      this.emitChanged({
        sessionId,
        taskIds: [...new Set(mutationEvents.map((event) => event.taskId))],
        at: Date.now(),
      });
      await this.write(sessionId, next);
    });
    return next;
  }

  private async appendEvents(sessionId: string, events: TaskLedgerEvent[]): Promise<void> {
    if (events.length === 0) return;
    this.#lease.transaction('write', () => {
      for (const event of events) insertTaskLedgerEvent(this.#lease.database, sessionId, event);
    });
  }

  private async write(sessionId: string, tasks: Task[]): Promise<void> {
    this.#lease.transaction('write', () => {
      writeTaskLedgerProjection(this.#lease.database, sessionId, tasks);
    });
  }

  private copyConversationLedger(
    sessionId: string,
    events: readonly TaskLedgerEvent[],
    tasks: readonly Task[],
  ): void {
    this.#lease.transaction('write', () => {
      const existing = this.#lease.database
        .prepare(`
          SELECT
            (SELECT COUNT(*) FROM workflow_task_ledger_events WHERE session_id = ?) +
            (SELECT COUNT(*) FROM workflow_task_ledger_projections WHERE session_id = ?) AS count
        `)
        .get(sessionId, sessionId) as { count?: unknown };
      if (existing.count !== 0) {
        throw new Error('Task Ledger conversation-copy target already exists');
      }
      for (const event of events) insertTaskLedgerEvent(this.#lease.database, sessionId, event);
      writeTaskLedgerProjection(this.#lease.database, sessionId, [...tasks]);
    });
  }

  private applyListOptions(tasks: Task[], options: TaskLedgerListOptions): Task[] {
    const now = options.now ?? Date.now();
    const filtered = tasks.filter((task) => {
      if (options.status && task.status !== options.status) return false;
      if (options.includeTerminal === false && isTerminalTaskStatus(task.status)) return false;
      if (
        options.includeArchived === false &&
        isTerminalTaskStatus(task.status) &&
        task.endedAt !== undefined &&
        task.endedAt <= now - TASK_ARCHIVE_AFTER_MS
      )
        return false;
      return true;
    });
    if (options.classifyResumeTrust !== true) return filtered;
    return filtered.map((task) => ({
      ...task,
      resumeTrust: task.resumeTrust ?? classifyTaskResumeTrust(task),
    }));
  }

  private emitChanged(event: TaskLedgerChangedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* observers cannot perturb the ledger */
      }
    }
  }
}

function readSqliteTaskLedgerEvents(database: DatabaseSync, sessionId: string): TaskLedgerEvent[] {
  assertSafeSessionId(sessionId);
  const rows = database
    .prepare(`
      SELECT record_json
      FROM workflow_task_ledger_events
      WHERE session_id = ?
      ORDER BY sequence
    `)
    .all(sessionId) as Array<{ record_json?: unknown }>;
  return rows.map((row, index) => {
    if (typeof row.record_json !== 'string') {
      throw new Error(`Invalid SQLite task event at sequence ${index}`);
    }
    const parsed = JSON.parse(row.record_json);
    if (!isTaskLedgerEvent(parsed) || parsed.sessionId !== sessionId) {
      throw new Error(`Invalid SQLite task event at sequence ${index}`);
    }
    return parsed;
  });
}

function insertTaskLedgerEvent(
  database: DatabaseSync,
  sessionId: string,
  event: TaskLedgerEvent,
): void {
  const row = database
    .prepare(`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
      FROM workflow_task_ledger_events
      WHERE session_id = ?
    `)
    .get(sessionId) as { sequence?: unknown };
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence)) {
    throw new Error('Invalid next task event sequence');
  }
  database
    .prepare(`
      INSERT INTO workflow_task_ledger_events(
        session_id, sequence, event_id, record_json
      ) VALUES (?, ?, ?, ?)
    `)
    .run(sessionId, row.sequence, event.eventId, JSON.stringify(event));
}

function writeTaskLedgerProjection(database: DatabaseSync, sessionId: string, tasks: Task[]): void {
  database
    .prepare(`
      INSERT INTO workflow_task_ledger_projections(session_id, record_json)
      VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET record_json = excluded.record_json
    `)
    .run(sessionId, JSON.stringify(tasks));
}

function nextTaskKey(tasks: readonly Task[], parent: Task | undefined): string {
  const siblings = tasks.filter((task) => task.parentId === parent?.id);
  const prefix = parent ? `${parent.key}.` : 'T';
  const used = new Set(siblings.map((task) => task.key));
  let index = 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  const key = `${prefix}${index}`;
  if (!isTaskKey(key))
    throw new Error(
      `Task hierarchy is too deep to allocate a stable key under ${parent?.key ?? 'root'}`,
    );
  return key;
}

function assertChildTaskOwner(
  owner: TaskOwner,
): asserts owner is TaskOwner & { actor: 'child_agent'; agentId: string; turnId: string } {
  if (owner.actor !== 'child_agent' || !owner.agentId || !owner.turnId || !isTaskOwner(owner)) {
    throw new Error(
      'Child task ownership requires stable child_agent agentId and turnId references',
    );
  }
}

function ownerFromContext(context: TaskLedgerMutationContext): TaskOwner | undefined {
  if (context.actor !== 'main_agent') return undefined;
  return {
    actor: 'main_agent',
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
  };
}

function assertDescendantsTerminal(tasks: readonly Task[], parentId: string): void {
  const pending = [parentId];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const child of tasks.filter((task) => task.parentId === current)) {
      if (!isTerminalTaskStatus(child.status)) {
        throw new Error(
          `Cannot complete a parent while descendant ${child.key} is ${child.status}`,
        );
      }
      pending.push(child.id);
    }
  }
}

function normalizeOutcomeReason(value: string | undefined, fallback: string): string {
  const normalized = (value ?? fallback).normalize('NFC').replace(/\s+/g, ' ').trim();
  return Array.from(normalized).slice(0, 1000).join('');
}

function clearStaleTaskEvidence(task: Task): Task {
  const next: Task = { ...task };
  if (next.status !== 'blocked') delete next.blockedReason;
  if (next.status !== 'failed') delete next.failureReason;
  if (next.status !== 'completed') delete next.completionEvidence;
  return next;
}

function rewriteConversationTaskEvent(
  event: TaskLedgerEvent,
  sourceSessionId: string,
  targetSessionId: string,
  runIds: ReadonlyMap<string, string>,
): TaskLedgerEvent {
  const owner = event.task.owner;
  const rewrittenOwner =
    owner === undefined
      ? undefined
      : {
          ...owner,
          ...(owner.sessionId === sourceSessionId ? { sessionId: targetSessionId } : {}),
          ...(owner.runId
            ? {
                runId: requiredConversationCopyRunId(runIds, owner.runId),
              }
            : {}),
        };
  const refs =
    event.refs === undefined
      ? undefined
      : {
          ...event.refs,
          ...(event.refs.runId
            ? { runId: requiredConversationCopyRunId(runIds, event.refs.runId) }
            : {}),
        };
  return {
    ...event,
    eventId: `task-copy-${createHash('sha256')
      .update(JSON.stringify([targetSessionId, event.eventId]))
      .digest('hex')}`,
    sessionId: targetSessionId,
    task: {
      ...event.task,
      ...(rewrittenOwner ? { owner: rewrittenOwner } : {}),
    },
    ...(refs ? { refs } : {}),
  };
}

function requiredConversationCopyRunId(
  runIds: ReadonlyMap<string, string>,
  sourceRunId: string,
): string {
  const targetRunId = runIds.get(sourceRunId);
  if (!targetRunId) {
    throw new Error(`Conversation copy is missing AgentRun ${sourceRunId}`);
  }
  return targetRunId;
}

function buildTaskLedgerEvent(input: {
  type: TaskLedgerEvent['type'];
  sessionId: string;
  task: Task;
  previous?: Task;
  context: TaskLedgerMutationContext;
}): TaskLedgerEvent {
  return {
    eventId: `task-event-${randomUUID()}`,
    type: input.type,
    ts: Date.now(),
    sessionId: input.sessionId,
    taskId: input.task.id,
    ...(input.previous ? { previousStatus: input.previous.status } : {}),
    nextStatus: input.task.status,
    task: input.task,
    ...((input.context.reason ?? eventReason(input.task))
      ? { reason: input.context.reason ?? eventReason(input.task) }
      : {}),
    ...(eventEvidence(input.task) ? { evidence: eventEvidence(input.task) } : {}),
    ...(eventRefs(input.context) ? { refs: eventRefs(input.context) } : {}),
    ...(input.context.source ? { source: input.context.source } : {}),
    ...(input.context.actor ? { actor: input.context.actor } : {}),
  };
}

function eventReason(task: Task): string | undefined {
  return task.blockedReason ?? task.failureReason;
}

function eventEvidence(task: Task): string | undefined {
  return task.completionEvidence;
}

function eventRefs(context: TaskLedgerMutationContext): TaskLedgerEvent['refs'] | undefined {
  const refs = {
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
  };
  return Object.keys(refs).length === 0 ? undefined : refs;
}
