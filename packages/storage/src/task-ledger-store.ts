import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TASK_LEDGER_MAX_TASKS,
  TASK_ARCHIVE_AFTER_MS,
  findTaskByRef,
  isSafeTaskId,
  isTaskKey,
  isTaskOwner,
  isTerminalTaskStatus,
  isTaskStatus,
  isTaskLedgerEvent,
  normalizeUpdateTaskInput,
  normalizeCreateTaskInput,
  normalizeResumeTrust,
  normalizeTaskEvidenceText,
  normalizeTaskSubject,
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
  type TaskLedgerEventTaskSnapshot,
  type TaskLedgerListOptions,
  type TaskLedgerMutationContext,
  type TaskLedgerStore,
  type TaskOwner,
} from '@maka/core/task-ledger';
import { chainWrite } from './write-queue.js';
import { assertSafeSessionId } from './session-store.js';
import { registerTaskLedgerCanonicalReader } from './task-ledger-store-internal.js';

export type { TaskLedgerStore } from '@maka/core/task-ledger';

export function createTaskLedgerStore(workspaceRoot: string): TaskLedgerStore {
  return new FileTaskLedgerStore(workspaceRoot);
}

class FileTaskLedgerStore implements TaskLedgerStore {
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(event: TaskLedgerChangedEvent) => void>();

  constructor(workspaceRoot: string) {
    this.sessionsRoot = join(workspaceRoot, 'sessions');
    registerTaskLedgerCanonicalReader(this, {
      list: (sessionId, options) => this.#listCanonical(sessionId, options),
      get: (sessionId, id, options) => this.#getCanonical(sessionId, id, options),
    });
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

  async create(
    sessionId: string,
    drafts: unknown,
    context: TaskLedgerMutationContext = {},
  ): Promise<{ created: Task[]; total: number }> {
    assertSafeSessionId(sessionId);
    if (!Array.isArray(drafts) || drafts.length === 0) {
      throw new Error('TaskCreate requires at least one task draft');
    }
    // Front-door the per-batch cap before generating ids or normalizing drafts:
    // a single call can never add more than the absolute ledger cap, and rejecting
    // here avoids generating N uuids for a batch the write-queue total check
    // would refuse anyway. The total (existing + new) cap is still enforced
    // inside the serialized mutate callback below.
    if (drafts.length > TASK_LEDGER_MAX_TASKS) {
      throw new Error(
        `TaskCreate batch of ${drafts.length} tasks exceeds the ${TASK_LEDGER_MAX_TASKS}-task per-batch cap; split the work into smaller calls.`,
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

  private filePath(sessionId: string): string {
    return join(this.sessionsRoot, sessionId, 'tasks.json');
  }

  private eventsPath(sessionId: string): string {
    return join(this.sessionsRoot, sessionId, 'task-events.jsonl');
  }

  /**
   * Render-path read: a damaged event ledger falls back to the projection cache
   * as untrusted when possible, so resume/debug surfaces retain conservative
   * state without allowing writes to proceed from that cache.
   */
  private async readForRender(sessionId: string): Promise<Task[]> {
    try {
      return (await this.readProjected(sessionId)).tasks;
    } catch (eventError) {
      try {
        await readFile(this.eventsPath(sessionId), 'utf8');
        return await this.readUntrustedCache(sessionId);
      } catch (readEventError) {
        if ((readEventError as NodeJS.ErrnoException).code !== 'ENOENT') {
          return await this.readUntrustedCache(sessionId);
        }
      }
      try {
        return projectLegacySnapshots(
          decodeTaskSnapshots(await readFile(this.filePath(sessionId), 'utf8')),
        ).tasks;
      } catch {
        return [];
      }
    }
  }

  private async readUntrustedCache(sessionId: string): Promise<Task[]> {
    try {
      const tasks = projectLegacySnapshots(
        decodeTaskSnapshots(await readFile(this.filePath(sessionId), 'utf8')),
      ).tasks;
      return tasks.map((task) => ({ ...task, resumeTrust: 'untrusted' }));
    } catch {
      return [];
    }
  }

  /**
   * Mutate-path read: only ENOENT means a legitimately fresh ledger. Any
   * other read error, undecodable JSON, or a non-array payload throws so the
   * mutation fails closed instead of rebuilding the ledger from [] and
   * silently overwriting whatever is on disk.
   */
  private async readForMutateWithSource(sessionId: string): Promise<{
    tasks: Task[];
    source: 'events' | 'legacy';
    backfilledTaskIds: string[];
  }> {
    try {
      const projected = await this.readProjected(sessionId);
      return {
        tasks: projected.tasks,
        source: 'events',
        backfilledTaskIds: projected.backfilledTaskIds,
      };
    } catch (eventError) {
      try {
        await readFile(this.eventsPath(sessionId), 'utf8');
        throw eventError;
      } catch (readEventError) {
        if ((readEventError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw eventError;
        }
      }
    }
    let text: string;
    try {
      text = await readFile(this.filePath(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { tasks: [], source: 'legacy', backfilledTaskIds: [] };
      throw error;
    }
    try {
      const projected = projectLegacySnapshots(decodeTaskSnapshots(text));
      return {
        tasks: projected.tasks,
        source: 'legacy',
        backfilledTaskIds: projected.backfilledTaskIds,
      };
    } catch (error) {
      throw new Error(
        `Task ledger file for session ${sessionId} is corrupt; refusing to overwrite it: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async readProjected(
    sessionId: string,
  ): Promise<{ tasks: Task[]; backfilledTaskIds: string[] }> {
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
    return { tasks: projection.tasks, backfilledTaskIds: projection.backfilledTaskIds };
  }

  private async readTaskEvents(sessionId: string): Promise<TaskLedgerEvent[]> {
    const text = await readFile(this.eventsPath(sessionId), 'utf8');
    const events: TaskLedgerEvent[] = [];
    const lines = text.split(/\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid task event JSONL line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!isTaskLedgerEvent(parsed)) {
        throw new Error(`Invalid task event JSONL line ${index + 1}: unexpected event shape`);
      }
      events.push(parsed);
    }
    return events;
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
      const compatibilityEvents =
        currentRead.source === 'legacy'
          ? current.map((task) =>
              buildTaskLedgerEvent({
                type: 'task_imported',
                sessionId,
                task,
                context: { source: 'import', actor: 'system' },
              }),
            )
          : currentRead.backfilledTaskIds.flatMap((taskId) => {
              const task = current.find((candidate) => candidate.id === taskId);
              return task
                ? [
                    buildTaskLedgerEvent({
                      type: 'task_updated',
                      sessionId,
                      task,
                      previous: task,
                      context: {
                        source: 'recovery',
                        actor: 'system',
                        reason: 'backfilled task-ledger v2 fields',
                      },
                    }),
                  ]
                : [];
            });
      const appended = [...compatibilityEvents, ...mutationEvents];
      await this.appendEvents(sessionId, appended);
      this.emitChanged({
        sessionId,
        taskIds: [...new Set(appended.map((event) => event.taskId))],
        at: Date.now(),
      });
      await this.write(sessionId, next);
    });
    return next;
  }

  private async appendEvents(sessionId: string, events: TaskLedgerEvent[]): Promise<void> {
    if (events.length === 0) return;
    const filePath = this.eventsPath(sessionId);
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(
      filePath,
      events.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf8',
    );
  }

  private async write(sessionId: string, tasks: Task[]): Promise<void> {
    const filePath = this.filePath(sessionId);
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(tasks, null, 2) + '\n', 'utf8');
    await rename(tempPath, filePath);
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

function decodeTaskSnapshots(text: string): TaskLedgerEventTaskSnapshot[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('expected a JSON array of tasks');
  }
  const tasks: TaskLedgerEventTaskSnapshot[] = [];
  const seenIds = new Set<string>();
  for (const value of parsed) {
    const task = normalizePersistedTask(value);
    if (!task) continue;
    // A tasks.json with two records sharing an id would render two
    // indistinguishable tasks in the turn tail, and TaskUpdate's first-match
    // lookup would only ever touch the first -- the second is unreachable and
    // a mutate would silently keep both. Treat a duplicate id as corrupt so
    // the render path degrades to empty and the mutate path stays fail-closed
    // instead of rewriting a "half-correct" file.
    if (seenIds.has(task.id)) {
      throw new Error(
        `task ledger has a duplicate id "${task.id}"; refusing to load an ambiguous ledger`,
      );
    }
    seenIds.add(task.id);
    tasks.push(task);
  }
  // Enforce the same total-task cap as the write path on read. A hand-edited,
  // legacy, or externally-written tasks.json could otherwise carry an
  // unbounded number of valid records, which `list()` would inject into the
  // turn tail every turn. Treat over-cap as corrupt so the render path
  // degrades to empty (its caller already try/catches) and the mutate path
  // stays fail-closed instead of silently truncating-and-overwriting.
  if (tasks.length > TASK_LEDGER_MAX_TASKS) {
    throw new Error(
      `task ledger has ${tasks.length} tasks, exceeding the ${TASK_LEDGER_MAX_TASKS}-task cap; refusing to load an unbounded ledger`,
    );
  }
  return tasks;
}

function normalizePersistedTask(value: unknown): TaskLedgerEventTaskSnapshot | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Partial<Task>;
  // Timestamps must be finite: a hand-edited `1e999` parses to Infinity, and
  // JSON.stringify(Infinity) writes null, so the record would silently vanish
  // on the next write. Reject it up front (per-record drop) instead.
  if (
    typeof record.id !== 'string' ||
    !isSafeTaskId(record.id) ||
    typeof record.createdAt !== 'number' ||
    !Number.isFinite(record.createdAt) ||
    typeof record.updatedAt !== 'number' ||
    !Number.isFinite(record.updatedAt) ||
    !isTaskStatus(record.status)
  ) {
    return undefined;
  }
  // Re-apply the same subject normalization as the write path (NFC, whitespace
  // collapse, trim, length cap, non-empty) so a manually-edited or legacy
  // tasks.json cannot inject an overlong/blank subject into the turn tail
  // every turn. Invalid subjects drop the whole record, matching the existing
  // "single malformed entry discarded" semantic.
  const subject = normalizeTaskSubject(record.subject);
  if (!subject.ok) return undefined;
  return {
    id: record.id,
    ...(record.key && isTaskKey(record.key) ? { key: record.key } : {}),
    subject: subject.value,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.parentId && isSafeTaskId(record.parentId) ? { parentId: record.parentId } : {}),
    ...normalizeOptionalOwner(record.owner),
    ...(typeof record.endedAt === 'number' && Number.isFinite(record.endedAt)
      ? { endedAt: record.endedAt }
      : {}),
    ...normalizeOptionalEvidence(record.blockedReason, 'blockedReason'),
    ...normalizeOptionalEvidence(record.failureReason, 'failureReason'),
    ...normalizeOptionalEvidence(record.completionEvidence, 'completionEvidence'),
    ...normalizeOptionalResumeTrust(record.resumeTrust),
  };
}

function normalizeOptionalEvidence(
  value: unknown,
  field: 'blockedReason' | 'failureReason' | 'completionEvidence',
): Partial<Task> {
  if (value === undefined) return {};
  const normalized = normalizeTaskEvidenceText(value, field);
  if (!normalized.ok) return {};
  return { [field]: normalized.value } as Partial<Task>;
}

function normalizeOptionalResumeTrust(
  value: unknown,
): Pick<Task, 'resumeTrust'> | Record<string, never> {
  if (value === undefined) return {};
  const normalized = normalizeResumeTrust(value);
  if (!normalized.ok) return {};
  return { resumeTrust: normalized.value };
}

function normalizeOptionalOwner(value: unknown): Pick<Task, 'owner'> | Record<string, never> {
  if (!isTaskOwner(value)) return {};
  const owner = value;
  return {
    owner: {
      actor: owner.actor,
      ...(owner.sessionId ? { sessionId: owner.sessionId } : {}),
      ...(owner.agentId ? { agentId: owner.agentId } : {}),
      ...(owner.runId ? { runId: owner.runId } : {}),
      ...(owner.turnId ? { turnId: owner.turnId } : {}),
    },
  };
}

function projectLegacySnapshots(tasks: readonly TaskLedgerEventTaskSnapshot[]) {
  const projection = projectTaskLedgerEvents(
    tasks.map(
      (task, index): TaskLedgerEvent => ({
        eventId: `legacy-import-${index}`,
        type: 'task_imported',
        ts: task.createdAt,
        sessionId: 'legacy',
        taskId: task.id,
        nextStatus: task.status,
        task,
        source: 'import',
        actor: 'system',
      }),
    ),
  );
  if (projection.diagnostics.length > 0) {
    throw new Error(
      `legacy task ledger has projection diagnostics: ${projection.diagnostics.join('; ')}`,
    );
  }
  return projection;
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
