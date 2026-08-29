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

import { createHash } from 'node:crypto';
import {
  findTaskByRef,
  type Task,
  type TaskAgentOutcome,
  type TaskAvailableClaimScope,
  type TaskLedgerChangedEvent,
  type TaskLedgerListOptions,
  type TaskLedgerMutationContext,
  type TaskLedgerStore,
  type TaskOwner,
} from '@maka/core/task-ledger';
import {
  authenticateInteractiveTaskLedgerWriter,
  type InteractiveTaskLedgerWriter,
} from '@maka/storage/task-ledger-authority';
import {
  encodeTaskLedgerTask,
  encodeTaskLedgerQueryResult,
  encodeTaskMutationQueryResult,
  TASK_LEDGER_PAGE_MAX_BYTES,
  TASK_LEDGER_PAGE_MAX_ITEMS,
  TASK_MUTATION_PAGE_MAX_BYTES,
  TASK_MUTATION_PAGE_MAX_ITEMS,
  type OperationOutcome,
  type TaskLedgerQueryInput,
  type TaskLedgerQueryResult,
  type TaskLedgerRevision,
  type TaskLedgerTask,
  type TaskMutationCorrelation,
  type TaskMutationLookup,
  type TaskMutationQueryInput,
  type TaskMutationQueryResult,
  type TaskMutationRevision,
} from '../protocol/index.js';
import type { TaskLedgerOperationHandlerMap } from './operation-dispatcher.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import type { SessionPresenceReader } from './session-presence.js';
import { projectTaskMutationLookups } from './task-mutation-projection.js';

const CANONICAL_LIST_OPTIONS = Object.freeze({
  includeTerminal: true,
  includeArchived: false,
  classifyResumeTrust: true,
});

/** The Host-owned Task Ledger authority shared by Client queries and Runtime tools. */
export class HostTaskLedgerCoordinator implements TaskLedgerStore {
  readonly handlers: TaskLedgerOperationHandlerMap = {
    'task.ledger.query': (input) => this.#query(input),
    'task.mutation.query': (input) => this.#queryMutations(input),
  };

  readonly #writer: InteractiveTaskLedgerWriter;

  constructor(
    writer: InteractiveTaskLedgerWriter,
    private readonly sessionAdmission: SessionAdmissionGate,
    private readonly sessions: SessionPresenceReader,
  ) {
    this.#writer = authenticateInteractiveTaskLedgerWriter(writer);
  }

  list(sessionId: string, options?: TaskLedgerListOptions): Promise<Task[]> {
    return this.sessionAdmission.run(sessionId, () => this.#writer.list(sessionId, options));
  }

  get(sessionId: string, id: string, options?: TaskLedgerListOptions): Promise<Task | undefined> {
    return this.sessionAdmission.run(sessionId, () => this.#writer.get(sessionId, id, options));
  }

  create(
    sessionId: string,
    drafts: unknown,
    context?: TaskLedgerMutationContext,
  ): Promise<{ created: Task[]; total: number }> {
    return this.sessionAdmission.run(sessionId, () =>
      this.#writer.create(sessionId, drafts, context),
    );
  }

  update(
    sessionId: string,
    id: string,
    patch: unknown,
    context?: TaskLedgerMutationContext,
  ): Promise<{ updated: Task; total: number }> {
    return this.sessionAdmission.run(sessionId, () =>
      this.#writer.update(sessionId, id, patch, context),
    );
  }

  claim(
    sessionId: string,
    id: string,
    owner: TaskOwner,
    context?: TaskLedgerMutationContext,
  ): Promise<{ updated: Task; total: number }> {
    return this.sessionAdmission.run(sessionId, () =>
      this.#writer.claim(sessionId, id, owner, context),
    );
  }

  claimAvailable(
    sessionId: string,
    id: string,
    owner: TaskOwner,
    scope: TaskAvailableClaimScope,
    context?: TaskLedgerMutationContext,
  ): Promise<{ updated: Task; total: number }> {
    return this.sessionAdmission.run(sessionId, () =>
      this.#writer.claimAvailable(sessionId, id, owner, scope, context),
    );
  }

  settleAgentOutcome(
    sessionId: string,
    id: string,
    outcome: TaskAgentOutcome,
    context?: TaskLedgerMutationContext,
  ): Promise<{ updated: Task; total: number }> {
    return this.sessionAdmission.run(sessionId, () =>
      this.#writer.settleAgentOutcome(sessionId, id, outcome, context),
    );
  }

  subscribe(listener: (event: TaskLedgerChangedEvent) => void): () => void {
    return this.#writer.subscribe(listener);
  }

  #query(input: TaskLedgerQueryInput): Promise<OperationOutcome<'task.ledger.query'>> {
    return this.sessionAdmission.run(input.sessionId, async () => {
      if ((await this.sessions.probeSessionRemoval(input.sessionId)).kind !== 'present') {
        return notFound('Session was not found');
      }
      const tasks = (await this.#writer.list(input.sessionId, CANONICAL_LIST_OPTIONS)).map(
        encodeTaskLedgerTask,
      );
      const revision = taskLedgerRevision(tasks);

      if (input.kind === 'get') {
        return success(
          encodeTaskLedgerQueryResult({
            kind: 'task',
            sessionId: input.sessionId,
            revision,
            task: findTaskByRef(tasks, input.taskRef) ?? null,
          }),
        );
      }

      if (input.kind === 'list_continue' && input.revision !== revision) {
        return success({
          kind: 'revision_changed',
          expected: input.revision,
          actual: revision,
        });
      }

      const offset = input.kind === 'list_start' ? 0 : decodeCursor(input.cursor);
      if (
        offset === undefined ||
        offset > tasks.length ||
        (input.kind === 'list_continue' && offset === tasks.length)
      ) {
        return invalidRequest('Task ledger cursor is invalid');
      }
      return success(createPage(input.sessionId, revision, tasks, offset));
    });
  }

  #queryMutations(input: TaskMutationQueryInput): Promise<OperationOutcome<'task.mutation.query'>> {
    return this.sessionAdmission.run(input.sessionId, async () => {
      if ((await this.sessions.probeSessionRemoval(input.sessionId)).kind !== 'present') {
        return mutationNotFound('Session was not found');
      }
      const correlationDigest = taskMutationCorrelationDigest(input.correlations);
      const cursor = input.kind === 'continue' ? decodeTaskMutationCursor(input.cursor) : undefined;
      if (
        input.kind === 'continue' &&
        (!cursor ||
          cursor.sessionId !== input.sessionId ||
          cursor.correlationDigest !== correlationDigest ||
          input.revision !== taskMutationRevisionFromCursor(cursor))
      ) {
        return mutationInvalidRequest('Task mutation cursor is invalid');
      }

      const currentRows = await this.#writer.readSequencedEvents(input.sessionId);
      const currentWatermark = taskMutationWatermark(currentRows);
      if (input.kind === 'continue' && cursor) {
        const frozenRow = currentRows[cursor.throughSequence];
        if (!frozenRow || frozenRow.event.eventId !== cursor.throughEventId) {
          return mutationSuccess({
            kind: 'history_changed',
            expected: input.revision,
            actual: taskMutationRevision(input.sessionId, correlationDigest, currentWatermark),
          });
        }
      }

      const watermark = cursor
        ? { sequence: cursor.throughSequence, eventId: cursor.throughEventId }
        : currentWatermark;
      const rows = watermark
        ? currentRows.filter(({ sequence }) => sequence <= watermark.sequence)
        : [];
      const revision = taskMutationRevision(input.sessionId, correlationDigest, watermark);
      const lookups = projectTaskMutationLookups(rows, input.correlations);
      const offset = cursor?.offset ?? 0;
      if (offset > lookups.length || (offset === lookups.length && offset !== 0)) {
        return mutationInvalidRequest('Task mutation cursor is invalid');
      }
      return mutationSuccess(
        createTaskMutationPage(
          input.sessionId,
          revision,
          correlationDigest,
          watermark,
          lookups,
          offset,
        ),
      );
    });
  }
}

function taskLedgerRevision(tasks: readonly TaskLedgerTask[]): TaskLedgerRevision {
  return `sha256:${createHash('sha256').update(JSON.stringify(tasks)).digest('hex')}`;
}

function createPage(
  sessionId: string,
  revision: TaskLedgerRevision,
  tasks: readonly TaskLedgerTask[],
  offset: number,
): TaskLedgerQueryResult {
  const pageTasks: TaskLedgerTask[] = [];
  for (let index = offset; index < tasks.length; index += 1) {
    if (pageTasks.length >= TASK_LEDGER_PAGE_MAX_ITEMS) break;
    const task = tasks[index];
    if (!task) throw invariantFailure('Task projection index was out of bounds');
    const candidateTasks = [...pageTasks, task];
    const nextOffset = index + 1;
    const candidate = {
      kind: 'page' as const,
      sessionId,
      revision,
      tasks: candidateTasks,
      nextCursor: nextOffset < tasks.length ? encodeCursor(nextOffset) : null,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > TASK_LEDGER_PAGE_MAX_BYTES) {
      break;
    }
    pageTasks.push(task);
  }

  if (pageTasks.length === 0 && offset < tasks.length) {
    throw invariantFailure('A canonical Task exceeded the page result byte limit');
  }
  const nextOffset = offset + pageTasks.length;
  return encodeTaskLedgerQueryResult({
    kind: 'page',
    sessionId,
    revision,
    tasks: pageTasks,
    nextCursor: nextOffset < tasks.length ? encodeCursor(nextOffset) : null,
  });
}

function encodeCursor(offset: number): string {
  return String(offset);
}

function decodeCursor(cursor: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) return undefined;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function success(result: TaskLedgerQueryResult): OperationOutcome<'task.ledger.query'> {
  return { ok: true, result };
}

function invalidRequest(message: string): OperationOutcome<'task.ledger.query'> {
  return { ok: false, error: { code: 'invalid_request', message } };
}

function notFound(message: string): OperationOutcome<'task.ledger.query'> {
  return { ok: false, error: { code: 'not_found', message } };
}

function invariantFailure(message: string): Error {
  return new Error(`Task ledger coordinator invariant failed: ${message}`);
}

interface TaskMutationWatermark {
  readonly sequence: number;
  readonly eventId: string;
}

interface TaskMutationCursorPayload {
  readonly version: 1;
  readonly sessionId: string;
  readonly correlationDigest: string;
  readonly throughSequence: number;
  readonly throughEventId: string;
  readonly offset: number;
}

function taskMutationWatermark(
  rows: readonly { sequence: number; event: { eventId: string } }[],
): TaskMutationWatermark | undefined {
  const row = rows.at(-1);
  return row ? { sequence: row.sequence, eventId: row.event.eventId } : undefined;
}

function taskMutationCorrelationDigest(correlations: readonly TaskMutationCorrelation[]): string {
  return createHash('sha256').update(JSON.stringify(correlations)).digest('hex');
}

function taskMutationRevision(
  sessionId: string,
  correlationDigest: string,
  watermark: TaskMutationWatermark | undefined,
): TaskMutationRevision {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([sessionId, correlationDigest, watermark ?? null]))
    .digest('hex')}`;
}

function taskMutationRevisionFromCursor(cursor: TaskMutationCursorPayload): TaskMutationRevision {
  return taskMutationRevision(cursor.sessionId, cursor.correlationDigest, {
    sequence: cursor.throughSequence,
    eventId: cursor.throughEventId,
  });
}

function createTaskMutationPage(
  sessionId: string,
  revision: TaskMutationRevision,
  correlationDigest: string,
  watermark: TaskMutationWatermark | undefined,
  lookups: readonly TaskMutationLookup[],
  offset: number,
): TaskMutationQueryResult {
  const pageLookups: TaskMutationLookup[] = [];
  for (let index = offset; index < lookups.length; index += 1) {
    if (pageLookups.length >= TASK_MUTATION_PAGE_MAX_ITEMS) break;
    const lookup = lookups[index];
    if (!lookup) throw invariantFailure('Task mutation lookup index was out of bounds');
    const candidateLookups = [...pageLookups, lookup];
    const nextOffset = index + 1;
    const nextCursor =
      nextOffset < lookups.length && watermark
        ? encodeTaskMutationCursor({
            version: 1,
            sessionId,
            correlationDigest,
            throughSequence: watermark.sequence,
            throughEventId: watermark.eventId,
            offset: nextOffset,
          })
        : null;
    const candidate = {
      kind: 'page' as const,
      sessionId,
      revision,
      lookups: candidateLookups,
      nextCursor,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > TASK_MUTATION_PAGE_MAX_BYTES) break;
    pageLookups.push(lookup);
  }

  if (pageLookups.length === 0 && offset < lookups.length) {
    throw invariantFailure('A canonical Task mutation exceeded the page result byte limit');
  }
  const nextOffset = offset + pageLookups.length;
  const nextCursor =
    nextOffset < lookups.length && watermark
      ? encodeTaskMutationCursor({
          version: 1,
          sessionId,
          correlationDigest,
          throughSequence: watermark.sequence,
          throughEventId: watermark.eventId,
          offset: nextOffset,
        })
      : null;
  return encodeTaskMutationQueryResult({
    kind: 'page',
    sessionId,
    revision,
    lookups: pageLookups,
    nextCursor,
  });
}

function encodeTaskMutationCursor(cursor: TaskMutationCursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeTaskMutationCursor(cursor: string): TaskMutationCursorPayload | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      Object.keys(parsed).length !== 6 ||
      parsed.version !== 1 ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.correlationDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.correlationDigest) ||
      typeof parsed.throughSequence !== 'number' ||
      !Number.isSafeInteger(parsed.throughSequence) ||
      parsed.throughSequence < 0 ||
      typeof parsed.throughEventId !== 'string' ||
      typeof parsed.offset !== 'number' ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset <= 0
    ) {
      return undefined;
    }
    return parsed as unknown as TaskMutationCursorPayload;
  } catch {
    return undefined;
  }
}

function mutationSuccess(result: TaskMutationQueryResult): OperationOutcome<'task.mutation.query'> {
  return { ok: true, result };
}

function mutationInvalidRequest(message: string): OperationOutcome<'task.mutation.query'> {
  return { ok: false, error: { code: 'invalid_request', message } };
}

function mutationNotFound(message: string): OperationOutcome<'task.mutation.query'> {
  return { ok: false, error: { code: 'not_found', message } };
}
