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

import { isInteractionAnswerValidForRequest } from '@maka/core/interaction';
import type { StoredMessage } from '@maka/core/session';
import {
  abortable,
  readRuntimeHostConnectionCatalog,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { updateRuntimeHostSession } from './runtime-host-session-update.js';
import type {
  InteractionPendingSnapshot,
  SessionConfigurationPatch,
  SessionCatalogProjection,
  SessionContinuitySnapshot,
} from '@maka/runtime-host/protocol';
import { RuntimeHostSessionChannel } from './runtime-host-session-channel.js';
import type { MakaRunEnvironmentDeps, MakaRunOptions } from './run-command-core.js';
import { RunSessionInterrupted, type MakaRunSessionResult } from './run-session-result.js';
import { TurnOutcomeClassifier, acceptStoredTurn } from './run-turn-outcome.js';

/** Session commands observe Host-owned execution; they never publish client MCP. */
export async function runMakaSessionCommand(
  connection: RuntimeHostConnection,
  options: MakaRunOptions,
  env: Pick<MakaRunEnvironmentDeps, 'onSigint' | 'newId'>,
  allowDetach = true,
): Promise<MakaRunSessionResult> {
  const sessionId = options.sessionId!;
  const executing =
    options.prompt !== undefined || options.answers !== undefined || options.resumeExecution;
  const decidingSandbox = options.sandboxDecision !== undefined;
  if ((executing || decidingSandbox) && !allowDetach)
    throw new Error(
      'Session control execution requires a persistent installation; use the blocking legacy run path for temporary npx invocations',
    );
  // Never silently discard options that the old turn.start path supports.
  if (options.graph || options.cwd || options.projectId || options.timeoutMs) {
    throw new Error(
      'Session workspace, timeout and Graph overrides require the blocking legacy --resume <id> path',
    );
  }
  if (
    options.maxSteps !== undefined &&
    (options.prompt === undefined || options.placement !== undefined)
  ) {
    throw new Error('--max-steps requires an idle Session prompt without --queue/--steer');
  }
  const cancelled = new AbortController();
  const removeSigint = env.onSigint(() => cancelled.abort(new RunSessionInterrupted()));
  const observer = await SessionRunObserver.open(connection, sessionId, cancelled.signal).catch(
    (error) => {
      removeSigint();
      throw error;
    },
  );
  const assertActive = () => {
    cancelled.signal.throwIfAborted();
    observer.throwIfFailed();
  };
  try {
    assertActive();
    const configured =
      options.model !== undefined ||
      options.connection !== undefined ||
      options.thinking !== undefined
        ? await configureSessionModel(connection, options, assertActive)
        : undefined;
    const configuration = configured
      ? {
          connection: configured.llmConnectionSlug,
          model: configured.model,
          thinking: configured.thinkingLevel ?? null,
        }
      : undefined;
    let target = observer.snapshot.rootTurn?.turnId;
    if (options.recap) {
      const result = await abortable(
        () =>
          connection.request('session.recap.generate', {
            sessionId,
            effectId: env.newId(),
            reason: 'manual',
          }),
        cancelled.signal,
      );
      assertActive();
      if (result.kind === 'failed') throw new Error(`Session recap failed: ${result.errorClass}`);
      const executionBoundary = options.status
        ? await connection.request('session.execution_boundary.query', { sessionId })
        : undefined;
      assertActive();
      return {
        ...observer.status(),
        recap: result.text,
        ...(configuration ? { configuration } : {}),
        ...(executionBoundary ? { executionBoundary } : {}),
      };
    }
    let messageId: string | undefined;
    let submission: MakaRunSessionResult['submission'];
    let admittedQueueRevision: number | undefined;
    let admittedQueueEpoch: string | undefined;
    let fullAccess = false;
    if (executing) {
      const boundary = await connection.request('session.execution_boundary.query', { sessionId });
      assertActive();
      if (boundary.kind === 'external')
        throw new Error('This Session must be controlled by its owning harness');
      fullAccess = boundary.kind === 'bypass';
    }

    const authorizeExecution = async () => {
      assertActive();
      if (!options.yolo || fullAccess) return;
      await updateRuntimeHostSession(
        connection,
        sessionId,
        (current) =>
          connection.request('session.configuration.update', {
            sessionId,
            expectedRevision: current.revision,
            patch: { permissionMode: 'bypass' },
          }),
        { operation: 'session.configuration.update', assertRequestAllowed: assertActive },
      );
      assertActive();
    };
    assertActive();
    if (options.stop) {
      const root = observer.snapshot.rootTurn;
      if (!root || terminal(root.status)) return observer.status();
      const stopped = await connection.request('turn.stop', {
        sessionId,
        turnId: root.turnId,
        runId: root.runId,
      });
      return {
        sessionId,
        status: terminal(stopped.status)
          ? stopped.status === 'completed'
            ? 'completed'
            : 'failed'
          : 'running',
      };
    }
    if (decidingSandbox) {
      const pending = observer.approvals();
      if (pending.length !== 1)
        throw new Error(
          `Expected one pending sandbox request, found ${pending.length}; no decision was submitted`,
        );
      const request = pending[0]!;
      target = request.turnId;
      assertActive();
      // Submit only the identity observed by this invocation. Never retry an uncertain decision.
      await connection.request('interaction.answer', {
        sessionId,
        interactionId: request.interactionId,
        answer: { kind: 'sandbox_boundary', decision: options.sandboxDecision! },
      });
      observer.ignoreAnswered(request.interactionId);
    } else if (options.answers !== undefined) {
      const pending = observer.snapshot.interactions.pending.filter(
        (p) => p.request.kind === 'question',
      );
      if (pending.length !== 1)
        throw new Error(
          `Expected one pending AskUser batch, found ${pending.length}; no answer was submitted`,
        );
      const question = pending[0]!;
      if (
        !isInteractionAnswerValidForRequest(question.request, {
          kind: 'question',
          answers: options.answers,
        })
      )
        throw new Error(
          'Answers do not match the pending AskUser questions; no answer was submitted',
        );
      await authorizeExecution();
      target = question.turnId;
      // Use the observed identity exactly once. A dispatched answer is never retried here.
      await connection.request('interaction.answer', {
        sessionId,
        interactionId: question.interactionId,
        answer: { kind: 'question', answers: options.answers },
      });
      observer.ignoreAnswered(question.interactionId);
    } else if (options.resumeExecution) {
      const plan = await connection.request('turn.resume.query', { sessionId });
      assertActive();
      if (plan.disposition !== 'ready') throw new Error(`Execution cannot resume: ${plan.reason}`);
      await authorizeExecution();
      const resumed = await connection.request('turn.resume.start', {
        sessionId,
        turnId: env.newId(),
        sourceRunId: plan.sourceRunId,
        sourceRuntimeEventHighWater: plan.sourceRuntimeEventHighWater,
      });
      if (resumed.kind !== 'started')
        throw new Error(`Execution cannot resume: ${resumed.plan.reason}`);
      target = resumed.turn.turnId;
    } else if (options.prompt !== undefined) {
      if (options.maxSteps !== undefined) {
        const root = observer.snapshot.rootTurn;
        if (root && !terminal(root.status))
          throw new Error('--max-steps cannot be applied to a queued or active Turn');
        await authorizeExecution();
        const started = await connection.request('turn.start', {
          sessionId,
          turnId: env.newId(),
          content: { text: options.prompt },
          maxSteps: options.maxSteps,
        });
        if (started.kind !== 'started') throw new Error('Turn did not start');
        target = started.turn.turnId;
        submission = 'started';
      } else {
        await authorizeExecution();
        messageId = env.newId();
        const originHostEpoch = connection.hostEpoch;
        const submitted = await connection.request('turn.message.submit', {
          originHostEpoch,
          sessionId,
          messageId,
          content: { text: options.prompt },
          placement: options.placement ?? 'next_turn',
        });
        if (submitted.disposition === 'blocked')
          throw new Error('Message was blocked before execution');
        if (submitted.disposition === 'turn_started') {
          target = submitted.turnId;
          submission = 'started';
        } else if (submitted.disposition === 'steering') {
          submission = 'steering';
          admittedQueueRevision = submitted.queueRevision;
          admittedQueueEpoch = originHostEpoch;
          // Steering targets the Turn selected on attachment; it does not own a new Turn.
          if (!target)
            throw new Error(
              'Steering was admitted but its observed Turn is unavailable; query Session status before continuing',
            );
          messageId = undefined;
        } else if (submitted.disposition === 'inbox') {
          // Inbox admission does not own a worker Turn or a queue revision.
          // Return its receipt even with --wait; never reuse an older Turn's result.
          assertActive();
          const { queued: _queued, ...observed } = observer.status();
          return { ...observed, submission: 'inbox' };
        } else {
          target = undefined;
          submission = 'queued';
          admittedQueueRevision = submitted.queueRevision;
          admittedQueueEpoch = originHostEpoch;
        }
      }
    }
    assertActive();
    if (options.status || (!executing && !decidingSandbox && !options.wait && !options.result)) {
      const executionBoundary = await connection.request('session.execution_boundary.query', {
        sessionId,
      });
      assertActive();
      return {
        ...observer.status(),
        executionBoundary,
        ...(configuration ? { configuration } : {}),
      };
    }
    if (options.noWait) {
      if (submission !== 'queued' && submission !== 'steering')
        return { sessionId, status: 'running', ...(submission ? { submission } : {}) };
      const observed = observer.status();
      // Admission can precede its projection frame. Never report an older queue count as current.
      const { queued, ...withoutQueueCount } = observed;
      const hasAdmittedRevision =
        admittedQueueRevision !== undefined &&
        observer.snapshot.queue.hostEpoch === admittedQueueEpoch &&
        observer.snapshot.queue.queueRevision >= admittedQueueRevision;
      return { ...(hasAdmittedRevision ? observed : withoutQueueCount), submission };
    }
    if (!target && !messageId) target = await observer.latestTurn();
    if (!target && !messageId) return { sessionId, status: 'idle' };
    for (;;) {
      const version = observer.version;
      cancelled.signal.throwIfAborted();
      observer.throwIfFailed();
      if (messageId && !target) {
        const execution = await connection.request('turn.message.execution.query', {
          sessionId,
          messageIds: [messageId],
        });
        const resolution = execution.resolutions[0];
        if (resolution?.state === 'owned') target = resolution.turnId;
        else if (resolution?.state === 'cancelled' || resolution?.state === 'not_admitted') {
          throw new Error(`Submitted message is ${resolution.state}; it has no execution result`);
        }
      }
      if (target) {
        const questions = observer.questions(target);
        if (questions.length) return observer.questionResult(questions);
        const approvals = observer.approvals(target);
        if (approvals.length) return observer.approvalResult(approvals);
        const turn = await connection.request('turn.query', { sessionId, turnId: target });
        if (terminal(turn.status)) {
          const result = await observer.result(target);
          if (result) return result;
          if (options.result)
            throw new Error('The terminal result is still being published; query it again');
          await observer.changed(version);
          continue;
        }
        const unsupported = observer.snapshot.interactions.pending.find(
          (p) =>
            p.turnId === target &&
            p.request.kind !== 'question' &&
            p.request.kind !== 'sandbox_boundary',
        );
        if (unsupported)
          throw new Error(
            `Pending ${unsupported.request.kind} interaction cannot be answered by maka run. The Host Turn is still waiting; use an interactive client on this Host or run maka run --session ${sessionId} --stop with the same Host selection to stop it explicitly.`,
          );
        if (options.result) return { sessionId, status: 'running' };
      }
      await observer.changed(version);
    }
  } finally {
    removeSigint();
    await observer.close();
  }
}

function terminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

async function configureSessionModel(
  connection: RuntimeHostConnection,
  options: MakaRunOptions,
  assertActive: () => void,
): Promise<SessionCatalogProjection> {
  const selected =
    options.connection !== undefined
      ? (await readRuntimeHostConnectionCatalog(connection)).connections.find(
          (candidate) => candidate.slug === options.connection,
        )
      : undefined;
  if (options.connection !== undefined && !selected)
    throw new Error(`Runtime Host model connection is unavailable: ${options.connection}`);
  return updateRuntimeHostSession(
    connection,
    options.sessionId!,
    (current) => {
      const changesModel = options.model !== undefined || options.connection !== undefined;
      let patch: SessionConfigurationPatch = {
        thinkingLevel: options.thinking ?? null,
      };
      if (changesModel) {
        if (current.executorId && !selected) {
          patch = { ...patch, executorConfig: { model: options.model! } };
        } else {
          const connectionId = selected?.connectionId ?? current.llmConnectionId;
          if (!connectionId) throw new Error('Model selection requires an explicit --connection');
          patch = {
            ...patch,
            modelTarget: {
              kind: 'explicit',
              connectionId,
              connectionSlug: selected?.slug ?? current.llmConnectionSlug,
              model: options.model ?? current.model,
            },
          };
        }
      }
      return connection.request('session.configuration.update', {
        sessionId: options.sessionId!,
        expectedRevision: current.revision,
        patch,
      });
    },
    { operation: 'session.configuration.update', assertRequestAllowed: assertActive },
  );
}

class SessionRunObserver {
  readonly #connection: RuntimeHostConnection;
  readonly #sessionId: string;
  readonly #signal: AbortSignal;
  #channel!: RuntimeHostSessionChannel;
  #version = 0;
  #failure: unknown;
  #waiters = new Set<() => void>();
  #answered = new Set<string>();

  private constructor(connection: RuntimeHostConnection, sessionId: string, signal: AbortSignal) {
    this.#connection = connection;
    this.#sessionId = sessionId;
    this.#signal = signal;
  }

  static async open(
    connection: RuntimeHostConnection,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<SessionRunObserver> {
    const observer = new SessionRunObserver(connection, sessionId, signal);
    const changed = () => observer.#notify();
    const opened = await RuntimeHostSessionChannel.open({
      connection,
      sessionId,
      signal,
      now: Date.now,
      onTurnStarted: (turn) => {
        // Drain live events so a long-running observation cannot back up the channel.
        void (async () => {
          for await (const _event of turn.events) {
            /* results are reconciled from durable transcript */
          }
        })().catch((error) => {
          observer.#failure = error;
          changed();
        });
      },
      onRuntimeResourceChanged: changed,
      onInteractionPending: changed,
      onInteractionResolved: changed,
      onTranscriptSettlement: changed,
      onTranscriptReplaced: changed,
      onGoalChanged: changed,
      onSnapshotChanged: changed,
      onRecovered: changed,
      onFailed: (error) => {
        observer.#failure = error;
        changed();
      },
    });
    observer.#channel = opened.channel;
    opened.channel.activate();
    return observer;
  }

  get snapshot(): SessionContinuitySnapshot {
    return this.#channel.snapshot;
  }
  get version(): number {
    return this.#version;
  }
  throwIfFailed(): void {
    if (this.#failure) throw this.#failure;
  }
  ignoreAnswered(id: string): void {
    this.#answered.add(id);
  }

  questions(turnId?: string): InteractionPendingSnapshot[] {
    return this.snapshot.interactions.pending.filter(
      (p) =>
        p.request.kind === 'question' &&
        !this.#answered.has(p.interactionId) &&
        (turnId === undefined || p.turnId === turnId),
    );
  }

  questionResult(pending: readonly InteractionPendingSnapshot[]): MakaRunSessionResult {
    return {
      sessionId: this.#sessionId,
      status: 'needs_input',
      questions: pending.flatMap((p) => (p.request.kind === 'question' ? p.request.questions : [])),
      ...(pending.length > 1 ? { pendingQuestionCount: pending.length } : {}),
    };
  }

  approvals(turnId?: string): InteractionPendingSnapshot[] {
    return this.snapshot.interactions.pending.filter(
      (p) =>
        p.request.kind === 'sandbox_boundary' &&
        !this.#answered.has(p.interactionId) &&
        (turnId === undefined || p.turnId === turnId),
    );
  }

  approvalResult(pending: readonly InteractionPendingSnapshot[]): MakaRunSessionResult {
    return {
      sessionId: this.#sessionId,
      status: 'needs_approval',
      approvalRequests: pending.flatMap((p) =>
        p.request.kind === 'sandbox_boundary' ? [p.request] : [],
      ),
    };
  }

  status(): MakaRunSessionResult {
    const pending = this.questions();
    if (pending.length)
      return {
        ...this.questionResult(pending),
        queued: this.snapshot.queue.followup.length + this.snapshot.queue.steering.length,
      };
    const approvals = this.approvals();
    if (approvals.length)
      return {
        ...this.approvalResult(approvals),
        queued: this.snapshot.queue.followup.length + this.snapshot.queue.steering.length,
      };
    const root = this.snapshot.rootTurn;
    return {
      sessionId: this.#sessionId,
      status: !root
        ? 'idle'
        : root.status === 'completed'
          ? 'completed'
          : terminal(root.status)
            ? 'failed'
            : 'running',
      queued: this.snapshot.queue.followup.length + this.snapshot.queue.steering.length,
      ...(root && 'providerRetry' in root && root.providerRetry
        ? { providerRetry: root.providerRetry }
        : {}),
    };
  }

  async latestTurn(): Promise<string | undefined> {
    const result = await this.#connection.request('session.turn_landmarks.query', {
      sessionId: this.#sessionId,
      maxLandmarks: 1,
      turnId: null,
    });
    return result.landmarks.at(-1)?.turnId;
  }

  async result(turnId: string): Promise<MakaRunSessionResult | undefined> {
    const classifier = new TurnOutcomeClassifier(turnId, { recoverStoredRetries: true });
    await this.#channel.replayTranscript(async (messages: readonly StoredMessage[]) => {
      acceptStoredTurn(classifier, messages, turnId);
    }, this.#signal);
    const outcome = classifier.outcome('pending');
    if (!outcome) return undefined;
    if (outcome.status === 'completed' && outcome.sandboxBoundary === 'none') {
      return {
        sessionId: this.#sessionId,
        status: 'completed',
        finalOutput: outcome.finalOutput ?? '',
      };
    }
    return {
      sessionId: this.#sessionId,
      status: 'failed',
      error:
        outcome.sandboxBoundary === 'unresolved'
          ? 'Turn encountered an unresolved sandbox boundary'
          : (outcome.failure?.message ?? outcome.failure?.class ?? 'Turn failed'),
    };
  }

  changed(version: number): Promise<void> {
    this.#signal.throwIfAborted();
    if (this.#version !== version) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        this.#signal.removeEventListener('abort', abort);
        this.#waiters.delete(done);
        resolve();
      };
      const abort = () => {
        this.#waiters.delete(done);
        reject(this.#signal.reason);
      };
      this.#waiters.add(done);
      this.#signal.addEventListener('abort', abort, { once: true });
    });
  }

  #notify(): void {
    this.#version++;
    for (const wake of [...this.#waiters]) wake();
  }

  async close(): Promise<void> {
    await this.#channel.close();
  }
}
