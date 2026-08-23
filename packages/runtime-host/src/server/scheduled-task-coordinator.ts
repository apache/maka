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
import { botDisplayLabel } from '@maka/core/bot-events';
import { isBotDeliveryProvider } from '@maka/core/bot-chat-settings';
import { messageContentsEqual } from '@maka/core/events';
import { type ScheduledTask, type ScheduledTaskExecutionTemplate } from '@maka/core/scheduled-task';
import type { SessionHeader } from '@maka/core/session';
import {
  buildAgentScheduledTaskCreatePayload,
  buildScheduledTaskTool,
  SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_ID,
  SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_VERSION,
  type ScheduledTaskToolAuthority,
} from '@maka/runtime/scheduled-task-tools';
import { type MakaTool } from '@maka/runtime/tool-runtime';
import { type SessionManager } from '@maka/runtime/session-manager';
import {
  authenticateInteractiveScheduledTaskStoreWriter,
  type InteractiveScheduledTaskStoreWriter,
  type ScheduledTaskFireClaim,
  type ScheduledTaskFireExecution,
  ScheduledTaskStoreError,
} from '@maka/storage/scheduled-task-store';
import {
  isSessionNotFoundError,
  type ExecutionSessionWriter,
  type RootTurnAdmission,
} from '@maka/storage/execution-stores';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import {
  SCHEDULED_TASK_CATALOG_MAX_ITEMS,
  SCHEDULED_TASK_PAGE_MAX_ITEMS,
  SCHEDULED_TASK_RESULT_MAX_BYTES,
  type OperationOutcome,
  type ScheduledTaskChangedReason,
  type ScheduledTaskMutateInput,
  type ScheduledTaskQueryInput,
} from '../protocol/index.js';
import type { ScheduledTaskOperationHandlerMap } from './operation-dispatcher.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { HostedExecutionAuthority } from './hosted-execution-authority.js';
import type { SessionCreateInput } from '../protocol/session-catalog.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const NATIVE_PROVIDER_RETRY_MS = 5_000;

type ScheduledTaskSessions = Pick<ExecutionSessionWriter, 'readHeaderSnapshot'>;
type ScheduledTaskRuntime = Pick<SessionManager, 'sendMessage'>;
type ScheduledTaskRoot = Pick<HostedExecutionAuthority, 'admit'>;
type HostScheduledTaskChangeServiceLike = HostScheduledTaskCoordinatorInput['changes'];

interface ScheduledTaskNativeEffects {
  hasWorkspaceService(serviceId: string, version: string): boolean;
  callWorkspaceService(input: {
    readonly serviceId: string;
    readonly version: string;
    readonly method: string;
    readonly input: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}

export interface HostScheduledTaskCoordinatorInput {
  readonly store: InteractiveScheduledTaskStoreWriter;
  readonly sessions: ScheduledTaskSessions;
  readonly runtime: ScheduledTaskRuntime;
  readonly root: ScheduledTaskRoot;
  readonly runtimePolicy: RuntimePolicyStoresWriter;
  readonly nativeEffects: ScheduledTaskNativeEffects;
  readonly createSession: (input: SessionCreateInput) => Promise<void>;
  readonly changes: {
    publish(revision: number, reason: ScheduledTaskChangedReason, taskId: string): void;
  };
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly requestDrain: () => void;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
}

export class HostScheduledTaskSessionBusyError extends Error {
  readonly name = 'HostScheduledTaskSessionBusyError';
}

export interface HostScheduledTaskSessionRetirement {
  commit(): void;
  rollback(): void;
}

/** Host-owned ScheduledTask catalog, scheduler, fire admission, and tool authority. */
export class HostScheduledTaskCoordinator implements ScheduledTaskToolAuthority {
  readonly handlers: ScheduledTaskOperationHandlerMap = {
    'scheduled-task.query': (input) => this.#query(input),
    'scheduled-task.mutate': (input) => this.#mutate(input),
  };

  readonly modelTool: MakaTool;
  readonly #store: InteractiveScheduledTaskStoreWriter;
  readonly #sessions: ScheduledTaskSessions;
  readonly #runtime: ScheduledTaskRuntime;
  readonly #root: ScheduledTaskRoot;
  readonly #runtimePolicy: RuntimePolicyStoresWriter;
  readonly #nativeEffects: ScheduledTaskNativeEffects;
  readonly #createSession: HostScheduledTaskCoordinatorInput['createSession'];
  readonly #changes: HostScheduledTaskChangeServiceLike;
  readonly #acquireResidency: () => RuntimeHostResidency;
  readonly #requestDrain: () => void;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimeout: (timer: unknown) => void;

  #lane: Promise<void> = Promise.resolve();
  #revision = 0;
  #timer: unknown;
  #residency: RuntimeHostResidency | undefined;
  #prepared = false;
  #started = false;
  #draining = false;
  #closed = false;
  readonly #retiringSessions = new Set<string>();

  constructor(input: HostScheduledTaskCoordinatorInput) {
    this.#store = authenticateInteractiveScheduledTaskStoreWriter(input.store);
    this.#sessions = input.sessions;
    this.#runtime = input.runtime;
    this.#root = input.root;
    this.#runtimePolicy = input.runtimePolicy;
    this.#nativeEffects = input.nativeEffects;
    this.#createSession = input.createSession;
    this.#changes = input.changes;
    this.#acquireResidency = input.acquireResidency;
    this.#requestDrain = input.requestDrain;
    this.#now = input.now ?? Date.now;
    this.#newId = input.newId ?? randomUUID;
    this.#setTimeout = input.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimeout = input.clearTimeout ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.modelTool = buildScheduledTaskTool({ authority: this });
  }

  async prepareRecovery(): Promise<void> {
    if (this.#prepared) return;
    await this.#store.ready();
    this.#prepared = true;
    await this.#refreshResidency();
  }

  async assertRecoveryAdmission(admission: RootTurnAdmission): Promise<void> {
    if (!this.#prepared) {
      throw new Error('ScheduledTask recovery admission was inspected before Store recovery');
    }
    if (admission.execution.kind !== 'scheduled_task') return;
    const scheduledTaskId = admission.execution.scheduledTaskId;
    const claims = await this.#store.listPendingFires();
    const claim = claims.find((candidate) => candidate.task.id === scheduledTaskId);
    const execution = claim?.execution;
    if (
      !claim ||
      !execution ||
      execution.sessionId !== admission.sessionId ||
      execution.turnId !== admission.turnId ||
      execution.runId !== admission.runId ||
      execution.userMessageId !== admission.userMessageId ||
      admission.normalizedInput === null ||
      !messageContentsEqual({ text: claim.task.intent.body }, admission.normalizedInput)
    ) {
      throw new Error(`ScheduledTask admission ${admission.turnId} has no matching pending fire`);
    }
  }

  async recover(): Promise<void> {
    if (!this.#prepared) throw new Error('ScheduledTask recovery was not prepared');
    for (const claim of await this.#store.listPendingFires()) {
      if (this.#draining) return;
      if (claim.task.effect.kind === 'notify') {
        if (claim.nativeState === 'waiting_for_provider') {
          await this.#fulfill(claim, true);
        } else {
          await this.#settleFailure(
            claim,
            'The previous native notification stopped after delivery admission.',
          );
        }
        continue;
      }
      if (!claim.execution) {
        await this.#settleFailure(
          claim,
          'The previous fire stopped before a durable Agent execution was admitted.',
        );
        continue;
      }
      await this.#fulfill(claim, true);
    }
  }

  start(): void {
    if (!this.#prepared) throw new Error('ScheduledTask scheduler started before recovery');
    if (this.#draining || this.#started) return;
    this.#started = true;
    void this.#refresh().catch((error: unknown) => this.#fatal(error));
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#stopTimer();
    this.#releaseResidency();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.beginDrain();
    await this.#lane;
    this.#closed = true;
  }

  async create(input: {
    title: string;
    intentBody: string;
    schedule:
      | { kind: 'once'; runAt: number }
      | { kind: 'interval'; everySeconds: number; startAt?: number }
      | { kind: 'cron'; expression: string; startAt?: number };
    effect: 'session_resume' | 'agent_run' | 'notify_local';
    sessionId: string;
    maxFires?: number;
  }): Promise<ScheduledTask | { error: string }> {
    let execution: ScheduledTaskExecutionTemplate | undefined;
    if (input.effect !== 'notify_local') {
      try {
        const header = await this.#readResumableSession(input.sessionId);
        if (input.effect === 'agent_run') execution = executionTemplateFromHeader(header);
      } catch (error) {
        if (isSessionNotFoundError(error)) return { error: 'Session was not found' };
        return { error: errorMessage(error) };
      }
    }
    const payload = buildAgentScheduledTaskCreatePayload({
      ...input,
      ...(execution ? { execution } : {}),
      now: this.#now(),
    });
    if ('error' in payload) return payload;
    try {
      return await this.#commitCreate(payload);
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  list(): Promise<readonly ScheduledTask[]> {
    return this.#exclusive(() => this.#store.list());
  }

  beginSessionRetirement(
    sessionIds: readonly string[],
  ): Promise<HostScheduledTaskSessionRetirement> {
    const unique = [...new Set(sessionIds)];
    return this.#exclusive(async () => {
      const targets = new Set(unique);
      const [tasks, claims] = await Promise.all([
        this.#store.list(),
        this.#store.listPendingFires(),
      ]);
      const blocked =
        tasks.some(
          (task) => task.effect.kind === 'session_resume' && targets.has(task.effect.sessionId),
        ) || claims.some((claim) => targets.has(claim.execution?.sessionId ?? ''));
      if (blocked) {
        throw new HostScheduledTaskSessionBusyError(
          'Session retirement requires session-bound ScheduledTasks to be removed first',
        );
      }
      for (const sessionId of unique) this.#retiringSessions.add(sessionId);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        for (const sessionId of unique) this.#retiringSessions.delete(sessionId);
      };
      return Object.freeze({ commit: finish, rollback: finish });
    });
  }

  async pause(id: string): Promise<ScheduledTask | { error: string }> {
    return this.#toolMutation(() =>
      this.#commitTask('updated', async () => {
        await this.#store.cancelWaitingNativeFire(id);
        return this.#store.pause(id);
      }),
    );
  }

  async resume(id: string): Promise<ScheduledTask | { error: string }> {
    return this.#toolMutation(() => this.#commitTask('updated', () => this.#store.resume(id)));
  }

  async remove(id: string): Promise<{ ok: true } | { error: string }> {
    try {
      await this.#exclusive(async () => {
        await this.#store.cancelWaitingNativeFire(id);
        await this.#store.remove(id);
        this.#publish('deleted', id);
        await this.#refreshSchedule();
      });
      return { ok: true };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  async #query(input: ScheduledTaskQueryInput): Promise<OperationOutcome<'scheduled-task.query'>> {
    if (!this.#prepared) return queryFailure('host_not_ready', 'ScheduledTask is not ready');
    if (this.#draining) return queryFailure('host_draining', 'Runtime Host is draining');
    try {
      return await this.#exclusive(async () => {
        if (input.kind === 'get') {
          return {
            ok: true,
            result: { kind: 'task', task: (await this.#store.get(input.taskId)) ?? null },
          } as const;
        }
        const tasks = await this.#store.list();
        if (input.expectedRevision !== undefined && input.expectedRevision !== this.#revision) {
          return {
            ok: true,
            result: {
              kind: 'revision_changed',
              expected: input.expectedRevision,
              actual: this.#revision,
            },
          } as const;
        }
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > tasks.length ||
          (input.cursor !== undefined && offset === tasks.length)
        ) {
          return queryFailure('invalid_request', 'ScheduledTask cursor is invalid');
        }
        return {
          ok: true,
          result: createScheduledTaskPage(tasks, this.#revision, offset),
        } as const;
      });
    } catch {
      return queryFailure('persistence_failed', 'ScheduledTask catalog is unavailable');
    }
  }

  async #mutate(
    input: ScheduledTaskMutateInput,
  ): Promise<OperationOutcome<'scheduled-task.mutate'>> {
    if (!this.#prepared) return mutateFailure('host_not_ready', 'ScheduledTask is not ready');
    if (this.#draining) return mutateFailure('host_draining', 'Runtime Host is draining');
    try {
      if (input.kind === 'create') {
        return taskSuccess(
          await this.#commitCreate({ ...input.input, createdBy: { kind: 'user' } }),
        );
      }
      if (input.kind === 'delete') {
        await this.#exclusive(async () => {
          await this.#store.cancelWaitingNativeFire(input.taskId);
          await this.#store.remove(input.taskId);
          this.#publish('deleted', input.taskId);
          await this.#refreshSchedule();
        });
        return { ok: true, result: { kind: 'deleted', taskId: input.taskId } };
      }
      if (input.kind === 'trigger_now') {
        return taskSuccess(
          await this.#exclusive(async () => {
            const claim = await this.#store.claimNow(input.taskId, this.#now());
            await this.#refreshResidency();
            const task = await this.#fulfill(claim, false);
            if (!task) throw new ScheduledTaskNativeUnavailableError();
            return task;
          }),
        );
      }
      const task = await this.#commitTask('updated', () => {
        if (input.kind === 'update') {
          return this.#cancelWaitingNativeFireThen(input.taskId, () =>
            this.#store.update(input.taskId, input.patch, this.#now()),
          );
        }
        if (input.kind === 'pause') {
          return this.#cancelWaitingNativeFireThen(input.taskId, () =>
            this.#store.pause(input.taskId, this.#now()),
          );
        }
        if (input.kind === 'resume') return this.#store.resume(input.taskId, this.#now());
        if (input.kind === 'snooze') {
          return this.#cancelWaitingNativeFireThen(input.taskId, () =>
            this.#store.snooze(input.taskId, input.delayMs, this.#now()),
          );
        }
        return this.#store.clearRunHistory(input.taskId, this.#now());
      });
      return taskSuccess(task);
    } catch (error) {
      if (error instanceof ScheduledTaskStoreError) {
        return mutateFailure(
          error.code === 'not_found'
            ? 'not_found'
            : error.code === 'invalid_input'
              ? 'invalid_request'
              : 'operation_conflict',
          error.message,
        );
      }
      if (error instanceof ScheduledTaskMutationError) {
        return mutateFailure(error.code, error.message);
      }
      if (error instanceof ScheduledTaskNativeUnavailableError) {
        return mutateFailure('operation_conflict', errorMessage(error));
      }
      this.#requestDrain();
      return mutateFailure('persistence_failed', 'ScheduledTask mutation failed');
    }
  }

  async #commitCreate(input: unknown): Promise<ScheduledTask> {
    return this.#exclusive(async () => {
      const incognito = (await this.#runtimePolicy.runtimePolicy.getSnapshot()).policy.privacy
        .incognitoActive;
      if (incognito) {
        throw new ScheduledTaskMutationError(
          'operation_conflict',
          'SCHEDULED_TASK_INCOGNITO_ACTIVE',
        );
      }
      if ((await this.#store.list()).length >= SCHEDULED_TASK_CATALOG_MAX_ITEMS) {
        throw new ScheduledTaskMutationError(
          'operation_conflict',
          'ScheduledTask catalog limit reached',
        );
      }
      const task = await this.#store.create(input, this.#now());
      this.#publish('created', task.id);
      await this.#refreshSchedule();
      return task;
    });
  }

  #commitTask(
    reason: ScheduledTaskChangedReason,
    mutate: () => Promise<ScheduledTask>,
  ): Promise<ScheduledTask> {
    return this.#exclusive(async () => {
      const task = await mutate();
      this.#publish(reason, task.id);
      await this.#refreshSchedule();
      return task;
    });
  }

  async #cancelWaitingNativeFireThen<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    await this.#store.cancelWaitingNativeFire(taskId);
    return operation();
  }

  async #toolMutation(
    operation: () => Promise<ScheduledTask>,
  ): Promise<ScheduledTask | { error: string }> {
    try {
      return await operation();
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  async #refresh(): Promise<void> {
    await this.#exclusive(async () => {
      for (const claim of await this.#store.listPendingFires()) {
        if (claim.nativeState === 'waiting_for_provider') {
          await this.#fulfill(claim, true);
        }
      }
      while (!this.#draining) {
        const scan = await this.#store.claimNextDue(this.#now());
        for (const expired of scan.expired) this.#publish('updated', expired.id);
        const claim = scan.claim;
        if (!claim) break;
        await this.#refreshResidency();
        await this.#fulfill(claim, false);
      }
      await this.#refreshSchedule();
    });
  }

  async #fulfill(
    claim: ScheduledTaskFireClaim,
    recovering: boolean,
  ): Promise<ScheduledTask | undefined> {
    const incognito = (await this.#runtimePolicy.runtimePolicy.getSnapshot()).policy.privacy
      .incognitoActive;
    if (incognito) {
      return this.#settle(claim, 'blocked', '隐私模式已开启，定时任务没有触发。', 'blocked');
    }
    const task = claim.task;
    if (task.effect.kind === 'notify') {
      if (recovering && claim.nativeState !== 'waiting_for_provider') {
        return this.#settleFailure(
          claim,
          'The previous native notification stopped before delivery was confirmed.',
        );
      }
      if (task.effect.channel === 'bot' && !isBotDeliveryProvider(task.effect.platform)) {
        return this.#settle(
          claim,
          'blocked',
          `${botDisplayLabel(task.effect.platform)} 当前不是可投递目标。`,
          'blocked',
        );
      }
      if (
        !this.#nativeEffects.hasWorkspaceService(
          SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_ID,
          SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_VERSION,
        )
      ) {
        if (claim.nativeState !== 'waiting_for_provider') {
          await this.#store.setFireNativeState(claim.id, 'waiting_for_provider');
        }
        return undefined;
      }
      claim = await this.#store.setFireNativeState(claim.id, 'invoking');
      try {
        await this.#nativeEffects.callWorkspaceService({
          serviceId: SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_ID,
          version: SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_VERSION,
          method: task.effect.channel === 'local' ? 'notify_local' : 'notify_bot',
          input:
            task.effect.channel === 'local'
              ? { taskId: task.id, title: task.title }
              : {
                  taskId: task.id,
                  title: task.title,
                  body: task.intent.body,
                  platform: task.effect.platform,
                  chatId: task.effect.chatId,
                },
        });
      } catch (error) {
        return this.#settle(
          claim,
          'failed',
          `Native delivery outcome is unknown: ${errorMessage(error)}`,
          'failed',
        );
      }
      return this.#settle(
        claim,
        'ok',
        task.effect.channel === 'local'
          ? '本地提醒已触发。'
          : `已投递到 ${botDisplayLabel(task.effect.platform)}。`,
        'fired',
      );
    }

    let execution = claim.execution;
    if (!execution) {
      execution = {
        sessionId: task.effect.kind === 'session_resume' ? task.effect.sessionId : this.#newId(),
        turnId: this.#newId(),
        runId: this.#newId(),
        userMessageId: this.#newId(),
      };
      claim = await this.#store.bindFireExecution(claim.id, execution);
    }
    try {
      await this.#ensureAgentSession(task, execution);
      await this.#admitAgentRun(task, execution);
      return this.#settle(
        claim,
        'ok',
        task.effect.kind === 'session_resume'
          ? '已在原任务中继续执行。'
          : '已启动 Agent 任务执行。',
        'fired',
        execution,
      );
    } catch (error) {
      return this.#settleFailure(claim, errorMessage(error));
    }
  }

  async #ensureAgentSession(
    task: ScheduledTask,
    identity: ScheduledTaskFireExecution,
  ): Promise<void> {
    if (task.effect.kind === 'notify') throw new Error('Task effect is not an Agent execution');
    if (task.effect.kind === 'session_resume') {
      if (identity.sessionId !== task.effect.sessionId) {
        throw new Error('ScheduledTask Session identity changed');
      }
      await this.#readResumableSession(identity.sessionId);
      return;
    }
    try {
      await this.#sessions.readHeaderSnapshot(identity.sessionId);
      return;
    } catch (error) {
      if (!isSessionNotFoundError(error) && !isMissingRecord(error)) throw error;
    }
    const execution = task.effect.execution;
    await this.#createSession({
      sessionId: identity.sessionId,
      workspace:
        execution.projectId != null && execution.projectId !== ''
          ? { kind: 'project', projectId: execution.projectId }
          : { kind: 'host_path', path: execution.cwd },
      name: task.title,
      labels: ['scheduled-task'],
      modelTarget: {
        kind: 'explicit',
        connectionSlug: execution.llmConnectionSlug,
        model: execution.model,
      },
      ...(execution.thinkingLevel === undefined ? {} : { thinkingLevel: execution.thinkingLevel }),
      permissionMode: execution.permissionMode,
      collaborationMode: execution.collaborationMode,
      orchestrationMode: execution.orchestrationMode,
    });
  }

  async #admitAgentRun(task: ScheduledTask, identity: ScheduledTaskFireExecution): Promise<void> {
    const content = { text: task.intent.body };
    await this.#root.admit({
      ...identity,
      execution: { kind: 'scheduled_task', scheduledTaskId: task.id },
      content,
      start: ({ runId, userMessageId, onRunStarted }) => {
        if (runId !== identity.runId || userMessageId !== identity.userMessageId) {
          throw new Error('Runtime Host changed the ScheduledTask execution identity');
        }
        return this.#runtime.sendMessage(
          identity.sessionId,
          {
            turnId: identity.turnId,
            ...content,
            origin: { kind: 'scheduled_task', scheduledTaskId: task.id },
          },
          {
            runId: identity.runId,
            userMessageId: identity.userMessageId,
            durability: 'required',
            onRunStarted: async (startedRunId) => {
              if (startedRunId !== identity.runId) {
                throw new Error('Runtime started a different ScheduledTask AgentRun identity');
              }
              await onRunStarted();
            },
          },
        );
      },
    });
  }

  async #readResumableSession(sessionId: string): Promise<SessionHeader> {
    if (this.#retiringSessions.has(sessionId)) {
      throw new Error('Session lifecycle is changing');
    }
    const header = await this.#sessions.readHeaderSnapshot(sessionId);
    if (header.isArchived) {
      throw new Error('Archived Sessions cannot own session-bound ScheduledTasks');
    }
    return header;
  }

  async #settleFailure(claim: ScheduledTaskFireClaim, message: string): Promise<ScheduledTask> {
    return this.#settle(claim, 'failed', message, 'failed', claim.execution);
  }

  async #settle(
    claim: ScheduledTaskFireClaim,
    outcome: 'ok' | 'failed' | 'blocked',
    message: string,
    reason: ScheduledTaskChangedReason,
    execution?: ScheduledTaskFireExecution,
  ): Promise<ScheduledTask> {
    const task = await this.#store.settleFire(claim.id, {
      at: this.#now(),
      outcome,
      message,
      ...(execution ? { sessionId: execution.sessionId, runId: execution.runId } : {}),
    });
    this.#publish(reason, task.id);
    await this.#refreshSchedule();
    return task;
  }

  async #refreshSchedule(): Promise<void> {
    this.#stopTimer();
    await this.#refreshResidency();
    if (!this.#started || this.#draining) return;
    const [tasks, claims] = await Promise.all([this.#store.list(), this.#store.listPendingFires()]);
    const next = tasks
      .filter((task) => task.status === 'active' && task.nextFireAt !== null)
      .reduce<number | null>((earliest, task) => {
        const deadline = Math.min(task.nextFireAt!, task.expiresAt ?? task.nextFireAt!);
        return earliest === null || deadline < earliest ? deadline : earliest;
      }, null);
    const waitingForProvider = claims.some((claim) => claim.nativeState === 'waiting_for_provider');
    if (next === null && !waitingForProvider) return;
    const nextTaskDelay =
      next === null
        ? MAX_TIMER_DELAY_MS
        : Math.max(0, Math.min(MAX_TIMER_DELAY_MS, next - this.#now()));
    const delay = waitingForProvider
      ? Math.min(NATIVE_PROVIDER_RETRY_MS, nextTaskDelay)
      : nextTaskDelay;
    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined;
      void this.#refresh().catch((error: unknown) => this.#fatal(error));
    }, delay);
  }

  async #refreshResidency(): Promise<void> {
    const [tasks, claims] = await Promise.all([this.#store.list(), this.#store.listPendingFires()]);
    const shouldHold =
      !this.#draining &&
      (claims.length > 0 ||
        tasks.some((task) => task.status === 'active' && task.nextFireAt !== null));
    if (shouldHold && !this.#residency) this.#residency = this.#acquireResidency();
    if (!shouldHold) this.#releaseResidency();
  }

  #releaseResidency(): void {
    this.#residency?.release();
    this.#residency = undefined;
  }

  #publish(reason: ScheduledTaskChangedReason, taskId: string): void {
    this.#revision += 1;
    this.#changes.publish(this.#revision, reason, taskId);
  }

  #stopTimer(): void {
    if (this.#timer === undefined) return;
    this.#clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.#lane.then(operation, operation);
    this.#lane = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #fatal(_error: unknown): void {
    this.#requestDrain();
  }
}

class ScheduledTaskNativeUnavailableError extends Error {
  constructor() {
    super('ScheduledTask native delivery is waiting for a Desktop provider');
  }
}

class ScheduledTaskMutationError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'operation_conflict',
    message: string,
  ) {
    super(message);
    this.name = 'ScheduledTaskMutationError';
  }
}

function executionTemplateFromHeader(header: SessionHeader): ScheduledTaskExecutionTemplate {
  return {
    cwd: header.cwd,
    ...(header.projectId === undefined ? {} : { projectId: header.projectId }),
    llmConnectionSlug: header.llmConnectionSlug,
    model: header.model,
    ...(header.thinkingLevel === undefined ? {} : { thinkingLevel: header.thinkingLevel }),
    permissionMode: header.permissionMode,
    collaborationMode: header.collaborationMode ?? 'agent',
    orchestrationMode: header.orchestrationMode ?? 'default',
  };
}

function createScheduledTaskPage(
  tasks: readonly ScheduledTask[],
  revision: number,
  offset: number,
) {
  const page: ScheduledTask[] = [];
  for (let index = offset; index < tasks.length; index += 1) {
    if (page.length >= SCHEDULED_TASK_PAGE_MAX_ITEMS) break;
    const task = tasks[index];
    if (!task) throw new Error('ScheduledTask page index is invalid');
    const candidate = [...page, task];
    const nextOffset = offset + candidate.length;
    const result = {
      kind: 'page' as const,
      revision,
      tasks: candidate,
      nextCursor: nextOffset < tasks.length ? String(nextOffset) : null,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > SCHEDULED_TASK_RESULT_MAX_BYTES) {
      break;
    }
    page.push(task);
  }
  if (page.length === 0 && offset < tasks.length) {
    throw new Error('A ScheduledTask exceeds the query byte limit');
  }
  const nextOffset = offset + page.length;
  return {
    kind: 'page' as const,
    revision,
    tasks: page,
    nextCursor: nextOffset < tasks.length ? String(nextOffset) : null,
  };
}

function taskSuccess(task: ScheduledTask): OperationOutcome<'scheduled-task.mutate'> {
  return { ok: true, result: { kind: 'task', task } };
}

function queryFailure(
  code: 'host_not_ready' | 'host_draining' | 'invalid_request' | 'persistence_failed',
  message: string,
): OperationOutcome<'scheduled-task.query'> {
  return { ok: false, error: { code, message } };
}

function mutateFailure(
  code:
    | 'host_not_ready'
    | 'host_draining'
    | 'invalid_request'
    | 'not_found'
    | 'operation_conflict'
    | 'persistence_failed',
  message: string,
): OperationOutcome<'scheduled-task.mutate'> {
  return { ok: false, error: { code, message } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingRecord(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
