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
  TASK_LEDGER_PAGE_MAX_BYTES,
  TASK_LEDGER_PAGE_MAX_ITEMS,
  type OperationOutcome,
  type TaskLedgerQueryInput,
  type TaskLedgerQueryResult,
  type TaskLedgerRevision,
  type TaskLedgerTask,
} from '../protocol/index.js';
import type { TaskLedgerOperationHandlerMap } from './operation-dispatcher.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import type { SessionPresenceReader } from './session-presence.js';

const CANONICAL_LIST_OPTIONS = Object.freeze({
  includeTerminal: true,
  includeArchived: false,
  classifyResumeTrust: true,
});

/** The Host-owned Task Ledger authority shared by Client queries and Runtime tools. */
export class HostTaskLedgerCoordinator implements TaskLedgerStore {
  readonly handlers: TaskLedgerOperationHandlerMap = {
    'task.ledger.query': (input) => this.#query(input),
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
