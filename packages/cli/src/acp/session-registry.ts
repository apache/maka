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
import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import {
  RequestError,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type StopReason,
} from '@agentclientprotocol/sdk';
import type { SessionEvent } from '@maka/core/events';
import type { McpConfigFile } from '@maka/core/mcp';
import { isRuntimeHostTerminalTurn } from '@maka/runtime-host/adapter';
import {
  readRuntimeHostConnectionCatalog,
  readRuntimeHostSessionCatalogPage,
  RuntimeHostCatalogReadError,
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  RuntimeHostSubscriptionError,
  RuntimeHostSessionCatalogRevisionChangedError,
  type RuntimeHostReconnectingConnection,
  type RuntimeHostSessionCatalogPageCursor,
} from '@maka/runtime-host/client';
import {
  SESSION_CATALOG_CURSOR_MAX_BYTES,
  SESSION_CATALOG_CWD_MAX_BYTES,
  HOST_OPERATION_SPECS,
  type SessionCatalogProjection,
  type TurnSnapshot,
} from '@maka/runtime-host/protocol';
import { RuntimeHostSessionChannel } from '../runtime-host-session-channel.js';
import {
  RuntimeHostSessionUpdateError,
  getRuntimeHostSession,
  requireRuntimeHostSessionProjection,
  updateRuntimeHostSession,
} from '../runtime-host-session-update.js';
import {
  AcpSessionConfigInputError,
  createAcpSessionConfigPatch,
  projectAcpSessionConfigOptions,
  validateAcpSessionConfigOptionRequest,
} from './session-configuration.js';
import { AcpSessionEventMapper } from './session-event-mapper.js';
import { mapAcpPromptContent } from './prompt-content.js';
import { AcpSessionMcp, createAcpMcpConfig, type AcpMcpConnection } from './session-mcp.js';
import { AcpSessionInteractions, type AcpInteractionClient } from './session-interactions.js';

const ACP_SESSION_CURSOR_MAX_BYTES = 8 * 1024;

type AcpSessionRegistryOperation =
  | 'connection.catalog.query'
  | 'session.create'
  | 'session.catalog.query'
  | 'session.configuration.update'
  | 'subscription.open'
  | 'turn.start'
  | 'turn.stop';
type AcpSessionRegistryLifecycleOperation =
  | 'connect'
  | 'session.close'
  | AcpSessionRegistryOperation;

export interface AcpSessionRegistryConnection
  extends Pick<
      RuntimeHostReconnectingConnection,
      | 'reconnecting'
      | 'request'
      | 'openSessionSubscription'
      | 'openSessionSubscriptionOnce'
      | 'close'
    >,
    AcpMcpConnection {}

export interface AcpPromptContext {
  readonly signal: AbortSignal;
  readonly notify: (notification: SessionNotification) => Promise<void>;
  readonly interactions?: AcpInteractionClient;
}

export interface AcpSessionRegistryOptions {
  readonly connect: (signal: AbortSignal) => Promise<AcpSessionRegistryConnection>;
  readonly newSessionId?: () => string;
  readonly newTurnId?: () => string;
}

interface AcpAttachmentConfiguration {
  readonly notify: AcpPromptContext['notify'];
  tail: Promise<unknown>;
  metadataRevision?: number;
  options?: string;
  delivery?: Promise<void>;
}

interface ActiveAcpPrompt {
  readonly sessionId: string;
  readonly turnId: string;
  readonly mapper: AcpSessionEventMapper;
  readonly waiters: Set<() => void>;
  attachment?: RuntimeHostSessionChannel;
  transcript?: ReturnType<RuntimeHostSessionChannel['trackPromptTranscript']>;
  readonly projectionAbort: AbortController;
  projectionFailure?: unknown;
  dispatchStarted: boolean;
  startRequestSettled: boolean;
  admissionSettled: boolean;
  startedTurn?: TurnSnapshot;
  cancelled: boolean;
  finished: boolean;
  stopTask?: Promise<void>;
}

/** Owns all Runtime Host resources associated with one ACP connection. */
export class AcpSessionRegistry {
  readonly #connect: (signal: AbortSignal) => Promise<AcpSessionRegistryConnection>;
  readonly #newSessionId: () => string;
  readonly #newTurnId: () => string;
  readonly #inFlightOperations = new Set<Promise<unknown>>();
  readonly #ownedSessionIds = new Set<string>();
  readonly #mcps = new Map<string, AcpSessionMcp>();
  readonly #creationAbort = new AbortController();
  readonly #attachmentInteractions = new Map<string, AcpSessionInteractions>();
  readonly #attachments = new Map<string, Promise<RuntimeHostSessionChannel>>();
  readonly #attachmentConfigurations = new Map<string, AcpAttachmentConfiguration>();
  readonly #pendingConfigSets = new Map<string, Set<Promise<unknown>>>();
  readonly #activePrompts = new Map<string, Set<ActiveAcpPrompt>>();
  readonly #sessionCloseTasks = new Map<string, Promise<CloseSessionResponse>>();
  #connection: AcpSessionRegistryConnection | undefined;
  #connectTask: Promise<AcpSessionRegistryConnection> | undefined;
  #connectAbortController: AbortController | undefined;
  #closing = false;
  #connectionCloseTask: Promise<void> | undefined;
  #disposeTask: Promise<void> | undefined;

  constructor(options: AcpSessionRegistryOptions) {
    this.#connect = options.connect;
    this.#newSessionId = options.newSessionId ?? randomUUID;
    this.#newTurnId = options.newTurnId ?? randomUUID;
  }

  async create(params: NewSessionRequest, signal?: AbortSignal): Promise<NewSessionResponse> {
    this.#assertOpen('session.create');
    validateNewSessionParams(params);
    const mcpConfig = createAcpMcpConfig(params);
    return this.#track(this.#create(params, mcpConfig, signal));
  }

  async list(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.#assertOpen('session.catalog.query');
    return this.#track(this.#list(params));
  }

  async setConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    this.#assertOpen('session.configuration.update');
    if (!this.#ownedSessionIds.has(params.sessionId)) {
      throw RequestError.invalidParams(
        { reason: 'unknown_session' },
        'Session is not owned by this ACP connection',
      );
    }
    try {
      validateAcpSessionConfigOptionRequest(params);
    } catch (error) {
      throw requestErrorFromConfigInput(error);
    }
    const configuration = this.#attachmentConfigurations.get(params.sessionId);
    const operation = this.#track(
      configuration
        ? this.#queueConfiguration(configuration, () =>
            this.#setConfigOption(params, configuration),
          )
        : this.#setConfigOption(params),
    );
    let pending = this.#pendingConfigSets.get(params.sessionId);
    if (!pending) {
      pending = new Set();
      this.#pendingConfigSets.set(params.sessionId, pending);
    }
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
      if (pending.size === 0) this.#pendingConfigSets.delete(params.sessionId);
    }
  }

  async prompt(params: PromptRequest, context: AcpPromptContext): Promise<PromptResponse> {
    this.#assertOpen('turn.start');
    this.#assertOwned(params.sessionId);
    return this.#track(this.#prompt(params, context));
  }

  async cancel(params: CancelNotification): Promise<void> {
    if (this.#closing) return;
    await this.#cancelSession(params.sessionId);
  }

  async close(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    this.#assertOpen('session.close');
    const existing = this.#sessionCloseTasks.get(params.sessionId);
    if (existing) return existing;
    this.#assertOwned(params.sessionId);
    this.#ownedSessionIds.delete(params.sessionId);
    const configuration = this.#attachmentConfigurations.get(params.sessionId);
    const delivery = configuration?.delivery;
    this.#attachmentConfigurations.delete(params.sessionId);
    const task = this.#track(this.#closeSession(params.sessionId, delivery));
    this.#sessionCloseTasks.set(params.sessionId, task);
    const forget = () => {
      if (this.#sessionCloseTasks.get(params.sessionId) === task) {
        this.#sessionCloseTasks.delete(params.sessionId);
      }
    };
    void task.then(forget, forget);
    return task;
  }

  dispose(): Promise<void> {
    this.#closing = true;
    this.#connectAbortController?.abort();
    this.#creationAbort.abort();
    this.#disposeTask ??= this.#dispose();
    return this.#disposeTask;
  }

  async #prompt(params: PromptRequest, context: AcpPromptContext): Promise<PromptResponse> {
    const turnId = this.#newTurnId();
    const active: ActiveAcpPrompt = {
      sessionId: params.sessionId,
      turnId,
      mapper: new AcpSessionEventMapper({
        sessionId: params.sessionId,
        notify: async (notification) => {
          if (!this.#closing && this.#ownedSessionIds.has(params.sessionId)) {
            await context.notify(notification);
          }
        },
      }),
      waiters: new Set(),
      projectionAbort: new AbortController(),
      dispatchStarted: false,
      startRequestSettled: false,
      admissionSettled: false,
      cancelled: false,
      finished: false,
    };
    this.#addActivePrompt(active);
    const onAbort = () => {
      void this.#cancelPrompt(active).catch(() => undefined);
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    try {
      const content = await mapAcpPromptContent(params.prompt);
      let startInput;
      try {
        startInput = HOST_OPERATION_SPECS['turn.start'].decodeInput({
          sessionId: params.sessionId,
          turnId,
          content,
        });
      } catch {
        throw RequestError.invalidParams(
          { field: 'prompt', reason: 'runtime_host_admission_rejected' },
          'Prompt cannot be admitted by Runtime Host',
        );
      }
      if (active.cancelled) return { stopReason: await this.#cancelledStopReason(active) };

      const connection = await this.#getConnection('subscription.open');
      let attachment: RuntimeHostSessionChannel;
      try {
        attachment = await this.#ensureAttachment(params.sessionId, connection, context);
      } catch (error) {
        if (active.cancelled) return { stopReason: await this.#cancelledStopReason(active) };
        throw error;
      }
      active.attachment = attachment;
      this.#wake(active);
      if (active.cancelled) return { stopReason: await this.#cancelledStopReason(active) };

      await this.#mcps.get(params.sessionId)?.ready(active.projectionAbort.signal);
      if (active.cancelled) return { stopReason: await this.#cancelledStopReason(active) };
      active.transcript = attachment.trackPromptTranscript(turnId);
      const observation = this.#consumePromptEvents(active, attachment.eventsForTurn(turnId));
      // Mark the observer as handled immediately: turn.start may still be in flight
      // when the live subscription reports a failure.
      void observation.catch(() => undefined);
      active.dispatchStarted = true;
      this.#wake(active);
      try {
        const result = await connection.request('turn.start', startInput);
        active.startRequestSettled = true;
        active.admissionSettled = true;
        if (result.kind === 'started') active.startedTurn = result.turn;
        this.#wake(active);
        if (result.kind === 'blocked') {
          const error = new Error('Runtime Host blocked the requested Turn');
          attachment.failTurn(turnId, error);
          throw error;
        }
      } catch (error) {
        // A lost dispatched response does not establish whether Host admitted
        // this Turn. Retain this attempt until subscription or query facts do.
        active.startRequestSettled = true;
        active.admissionSettled ||= !(
          error instanceof RuntimeHostRequestInterruptedError && error.dispatch === 'dispatched'
        );
        if (!active.admissionSettled) {
          void connection.request('turn.query', { sessionId: active.sessionId, turnId }).then(
            (turn) => {
              active.startedTurn = turn;
              active.admissionSettled = true;
              this.#wake(active);
            },
            (queryError: unknown) => {
              // A retryable query interruption still leaves subscription
              // recovery as a fact source. Any permanent failure ends this
              // local attempt without claiming that Host rejected admission.
              if (
                !(queryError instanceof RuntimeHostRequestInterruptedError && queryError.retryable)
              ) {
                active.admissionSettled = true;
              }
              this.#wake(active);
            },
          );
        }
        this.#wake(active);
        attachment.failTurn(turnId, error);
        if (!active.cancelled) throw requestErrorFromRuntimeHost(error, 'turn.start');
      }

      if (active.cancelled) {
        await active.stopTask?.catch(() => undefined);
        return { stopReason: await this.#cancelledStopReason(active) };
      }
      const stopReason = await observation;
      return { stopReason };
    } catch (error) {
      // A failed projection must not leave the corresponding Host Turn running.
      active.stopTask ??= this.#stopPromptWhenObservable(active);
      await active.stopTask.catch(() => undefined);
      if (active.cancelled) return { stopReason: await this.#cancelledStopReason(active) };
      if (error instanceof RequestError) throw error;
      throw requestErrorFromRuntimeHost(error, 'subscription.open');
    } finally {
      context.signal.removeEventListener('abort', onAbort);
      active.projectionAbort.abort();
      active.transcript?.dispose();
      this.#attachmentInteractions.get(active.sessionId)?.cancelTurn(active.turnId);
      active.finished = true;
      this.#wake(active);
      this.#removeActivePrompt(active);
    }
  }

  async #consumePromptEvents(
    active: ActiveAcpPrompt,
    events: AsyncIterable<SessionEvent>,
  ): Promise<StopReason> {
    let terminalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
    try {
      for await (const event of events) {
        if (event.type === 'abort') terminalStatus = 'cancelled';
        else if (event.type === 'error' && !event.recoverable) terminalStatus = 'failed';
        if (terminalStatus !== 'completed') active.projectionAbort.abort();
        if (!active.cancelled) await active.mapper.accept(event);
      }
      if (active.cancelled) return this.#cancelledStopReason(active);
      if (terminalStatus === 'completed') await this.#reconcilePrompt(active);
      else active.projectionAbort.abort();
      if (active.projectionFailure) throw active.projectionFailure;
      await active.mapper.finishTools(active.turnId, terminalStatus);
      await active.mapper.flush();
      return active.cancelled ? this.#cancelledStopReason(active) : 'end_turn';
    } catch (error) {
      if (active.cancelled) return this.#cancelledStopReason(active);
      throw error;
    }
  }

  async #reconcilePrompt(active: ActiveAcpPrompt): Promise<void> {
    if (active.cancelled || active.finished || !active.transcript) return;
    try {
      await active.transcript.reconcile(
        (messages) => active.mapper.acceptTranscriptMessages(active.turnId, messages),
        active.projectionAbort.signal,
      );
    } catch (error) {
      if (active.cancelled || active.finished || active.projectionAbort.signal.aborted) return;
      active.projectionFailure ??= error;
      active.attachment?.failTurn(active.turnId, error);
      throw error;
    }
  }

  async #cancelledStopReason(active: ActiveAcpPrompt): Promise<'cancelled'> {
    await active.mapper.flush();
    return 'cancelled';
  }

  #cancelSession(sessionId: string): Promise<PromiseSettledResult<void>[]> {
    const active = [...(this.#activePrompts.get(sessionId) ?? [])];
    const cancellations = active.map((prompt) => this.#cancelPrompt(prompt));
    const attachment = this.#attachments.get(sessionId);
    if (attachment) {
      cancellations.push(
        attachment.then(
          async (opened) => {
            const root = opened.snapshot.rootTurn;
            // Local prompts already latch cancellation across pending turn.start.
            // An idle attachment may also observe a Turn started by another client.
            if (
              root &&
              !isRuntimeHostTerminalTurn(root) &&
              !active.some((prompt) => prompt.turnId === root.turnId)
            ) {
              await this.#connection?.request('turn.stop', {
                sessionId: root.sessionId,
                turnId: root.turnId,
                runId: root.runId,
              });
            }
          },
          () => undefined,
        ),
      );
    }
    return Promise.allSettled(cancellations);
  }

  async #cancelPrompt(active: ActiveAcpPrompt): Promise<void> {
    active.cancelled = true;
    active.projectionAbort.abort();
    this.#attachmentInteractions.get(active.sessionId)?.cancelTurn(active.turnId);
    active.stopTask ??= this.#stopPromptWhenObservable(active);
    await Promise.all([
      active.mapper.flush(),
      active.stopTask.catch((error: unknown) => {
        // End only this prompt's observation. Failed delivery does not establish
        // a terminal Host Turn, and teardown still receives the original error.
        active.attachment?.failTurn(active.turnId, error);
        throw error;
      }),
    ]);
  }

  async #stopPromptWhenObservable(active: ActiveAcpPrompt): Promise<void> {
    if (!active.dispatchStarted) return;
    while (!active.finished) {
      const observed = active.attachment?.snapshot.rootTurn;
      // Subscription teardown can precede the start response. Keep the admitted
      // identity until exact Stop completes, even when observation has ended.
      const root = observed?.turnId === active.turnId ? observed : active.startedTurn;
      if (root) {
        if (isRuntimeHostTerminalTurn(root)) return;
        const connection = this.#connection;
        if (!connection) return;
        try {
          await connection.request('turn.stop', {
            sessionId: root.sessionId,
            turnId: root.turnId,
            runId: root.runId,
          });
        } catch (error) {
          console.error('[acp] Host Stop delivery failed:', error);
          throw error;
        }
        return;
      }
      if (active.admissionSettled && active.startRequestSettled) return;
      await this.#waitForPromptChange(active);
    }
  }

  async #ensureAttachment(
    sessionId: string,
    connection: AcpSessionRegistryConnection,
    context: AcpPromptContext,
  ): Promise<RuntimeHostSessionChannel> {
    const existing = this.#attachments.get(sessionId);
    if (existing) return existing;
    const configuration: AcpAttachmentConfiguration = {
      notify: context.notify,
      // Setters can outlive an absent or failed attachment. Their responses
      // must precede refreshes delivered by the new attachment's queue.
      tail: Promise.allSettled([...(this.#pendingConfigSets.get(sessionId) ?? [])]),
    };
    this.#attachmentConfigurations.set(sessionId, configuration);
    let task!: Promise<RuntimeHostSessionChannel>;
    let attachment: RuntimeHostSessionChannel | undefined;
    let earlyFailure: Error | undefined;
    const failAttachment = (error: Error) => {
      if (!attachment) {
        earlyFailure = error;
        return;
      }
      this.#retireFailedAttachment(sessionId, task, attachment, error);
    };
    const interactions = new AcpSessionInteractions({
      sessionId,
      connection,
      client: context.interactions ?? {
        capabilities: {},
        requestPermission: async () => {
          throw RequestError.methodNotFound('session/request_permission');
        },
        createElicitation: async () => {
          throw RequestError.methodNotFound('elicitation/create');
        },
      },
      onPending: async (pending) => {
        for (const active of this.#activePrompts.get(sessionId) ?? []) {
          if (active.turnId === pending.turnId && !active.cancelled) {
            await active.mapper.pendingInteraction(pending);
          }
        }
      },
      onAnswered: (answered, pending) => attachment?.publishInteractionAnswer(answered, pending),
      onResolved: async (resolved, pending) => {
        for (const active of this.#activePrompts.get(sessionId) ?? []) {
          if (active.turnId === pending.turnId && !active.cancelled && !active.finished) {
            await active.mapper.resolvedInteraction(resolved, pending);
          }
        }
      },
      onFailure: (pending, error) => {
        const active = [...(this.#activePrompts.get(sessionId) ?? [])].find(
          (prompt) => prompt.turnId === pending.turnId && !prompt.finished,
        );
        if (active?.attachment) {
          active.projectionFailure ??= error;
          active.attachment.failTurn(active.turnId, error);
        } else if (!attachment) failAttachment(error);
      },
      onCancelled: (pending) => {
        for (const active of this.#activePrompts.get(sessionId) ?? []) {
          if (active.turnId === pending.turnId)
            void this.#cancelPrompt(active).catch(() => undefined);
        }
      },
    });
    this.#attachmentInteractions.set(sessionId, interactions);
    task = RuntimeHostSessionChannel.open({
      connection,
      openInitialSessionSubscription: connection.openSessionSubscriptionOnce.bind(connection),
      sessionId,
      now: Date.now,
      onTurnStarted: () => undefined,
      onRuntimeResourceChanged: () => undefined,
      onSnapshotChanged: (snapshot) => {
        this.#wakeSession(sessionId);
        if (configuration.metadataRevision === undefined) {
          configuration.metadataRevision = snapshot.session.metadataRevision;
          return;
        }
        if (configuration.metadataRevision === snapshot.session.metadataRevision) return;
        configuration.metadataRevision = snapshot.session.metadataRevision;
        void this.#queueConfiguration(configuration, async () => {
          if (!this.#configurationIsLive(sessionId, configuration)) return;
          const session = await getRuntimeHostSession(connection, sessionId);
          if (!session) throw unknownSessionError();
          const configOptions = await this.#projectConfigOptions(connection, session);
          await this.#notifyConfiguration(sessionId, configuration, configOptions);
        }).catch((error: unknown) => {
          // Closing or replacing the attachment intentionally invalidates any
          // in-flight presentation refresh; its interrupted read is no longer actionable.
          if (this.#configurationIsLive(sessionId, configuration)) {
            console.error('[acp] Session configuration refresh failed:', error);
          }
        });
      },
      onTranscriptReplaced: (turnId, messages) => {
        for (const active of this.#activePrompts.get(sessionId) ?? []) {
          if (active.turnId === turnId && !active.cancelled) {
            void active.mapper.replaceTranscript(turnId, messages).catch((error: unknown) => {
              active.attachment?.failTurn(turnId, error);
            });
          }
        }
      },
      onInteractionPending: (pending) => {
        void interactions.pending(pending);
      },
      onInteractionResolved: (pending) => {
        void interactions.resolved(pending);
      },
      onTranscriptSettlement: (turnId) => {
        for (const active of this.#activePrompts.get(sessionId) ?? []) {
          if (active.turnId === turnId) void this.#reconcilePrompt(active).catch(() => undefined);
        }
      },
      onGoalChanged: () => undefined,
      onFailed: failAttachment,
      onRecovered: () => undefined,
    })
      .then(({ channel }) => {
        channel.activate();
        attachment = channel;
        if (earlyFailure) {
          this.#retireFailedAttachment(sessionId, task, channel, earlyFailure);
          throw earlyFailure;
        }
        if (this.#closing || !this.#ownedSessionIds.has(sessionId)) {
          return channel.close().then(() => {
            throw this.#closing ? registryClosedError('subscription.open') : unknownSessionError();
          });
        }
        return channel;
      })
      .catch((error: unknown) => {
        interactions.close();
        if (this.#attachmentInteractions.get(sessionId) === interactions) {
          this.#attachmentInteractions.delete(sessionId);
        }
        if (this.#attachments.get(sessionId) === task) {
          this.#attachments.delete(sessionId);
          this.#attachmentConfigurations.delete(sessionId);
        }
        if (error instanceof RequestError) throw error;
        throw requestErrorFromRuntimeHost(error, 'subscription.open');
      });
    this.#attachments.set(sessionId, task);
    return task;
  }

  #retireFailedAttachment(
    sessionId: string,
    task: Promise<RuntimeHostSessionChannel>,
    attachment: RuntimeHostSessionChannel,
    error: Error,
  ): void {
    if (this.#attachments.get(sessionId) === task) {
      this.#attachments.delete(sessionId);
      this.#attachmentConfigurations.delete(sessionId);
      this.#attachmentInteractions.get(sessionId)?.close();
      this.#attachmentInteractions.delete(sessionId);
    }
    for (const active of this.#activePrompts.get(sessionId) ?? []) {
      if (active.attachment !== attachment) continue;
      // Recovery has ended, so no future subscription fact can settle an
      // outcome-unknown admission. A pending start response may still provide
      // the exact identity and is handled before cancellation can retire.
      active.admissionSettled = true;
      attachment.failTurn(active.turnId, error);
      this.#wake(active);
    }
    void attachment.close().catch(() => undefined);
  }

  async #closeSession(sessionId: string, delivery?: Promise<void>): Promise<CloseSessionResponse> {
    const cancellation = await this.#cancelSession(sessionId);
    this.#attachmentInteractions.get(sessionId)?.close();
    this.#attachmentInteractions.delete(sessionId);
    const attachmentTask = this.#attachments.get(sessionId);
    this.#attachments.delete(sessionId);
    let closeError: unknown;
    if (attachmentTask) {
      try {
        // A rejected open has no retained resource; close still releases ownership.
        const attachment = await attachmentTask.catch(() => undefined);
        await attachment?.close();
      } catch (error) {
        closeError = error;
      }
    }
    const mcp = this.#mcps.get(sessionId);
    this.#mcps.delete(sessionId);
    try {
      await mcp?.close();
    } catch (error) {
      closeError ??= error;
    }
    await delivery;
    const failedCancellation = cancellation.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failedCancellation) throw failedCancellation.reason;
    if (closeError) throw closeError;
    return {};
  }

  #addActivePrompt(active: ActiveAcpPrompt): void {
    const prompts = this.#activePrompts.get(active.sessionId);
    if (prompts) prompts.add(active);
    else this.#activePrompts.set(active.sessionId, new Set([active]));
  }

  #removeActivePrompt(active: ActiveAcpPrompt): void {
    const prompts = this.#activePrompts.get(active.sessionId);
    prompts?.delete(active);
    if (prompts?.size === 0) this.#activePrompts.delete(active.sessionId);
  }

  #wakeSession(sessionId: string): void {
    for (const active of this.#activePrompts.get(sessionId) ?? []) this.#wake(active);
  }

  #wake(active: ActiveAcpPrompt): void {
    for (const resolve of active.waiters) resolve();
    active.waiters.clear();
  }

  #waitForPromptChange(active: ActiveAcpPrompt): Promise<void> {
    return new Promise((resolve) => active.waiters.add(resolve));
  }

  #assertOwned(sessionId: string): void {
    if (!this.#ownedSessionIds.has(sessionId)) throw unknownSessionError();
  }

  async #create(
    params: NewSessionRequest,
    mcpConfig: McpConfigFile,
    signal?: AbortSignal,
  ): Promise<NewSessionResponse> {
    const lifetime = signal
      ? AbortSignal.any([signal, this.#creationAbort.signal])
      : this.#creationAbort.signal;
    lifetime.throwIfAborted();
    const connection = await this.#getConnection('session.create');
    const sessionId = this.#newSessionId();
    let mcp: AcpSessionMcp | undefined;
    if (params.mcpServers.length > 0) {
      mcp = new AcpSessionMcp(sessionId, mcpConfig, connection);
      this.#mcps.set(sessionId, mcp);
    }
    let result;
    let dispatched = false;
    try {
      await mcp?.prepare(lifetime);
      lifetime.throwIfAborted();
      this.#assertOpen('session.create');
      dispatched = true;
      result = await connection.request('session.create', {
        sessionId,
        workspace: { kind: 'host_path', path: params.cwd },
        modelTarget: { kind: 'default' },
      });
    } catch (error) {
      const outcomeUnknown =
        dispatched &&
        error instanceof RuntimeHostRequestInterruptedError &&
        error.dispatch === 'dispatched';
      if (outcomeUnknown && !this.#closing) {
        // The error returns this ID. Keep its connection-local reservation usable
        // without guessing whether Host committed or resending Session creation.
        this.#ownedSessionIds.add(sessionId);
      } else {
        this.#mcps.delete(sessionId);
        await mcp?.close().catch(() => undefined);
      }
      if (error instanceof RequestError) throw error;
      throw requestErrorFromRuntimeHost(error, 'session.create', { sessionId });
    }
    // Session creation has committed. Optional presentation failures must not
    // turn that success into an unreachable durable Session.
    let configOptions: SessionConfigOption[] | undefined;
    try {
      const created = requireRuntimeHostSessionProjection(result, 'session.create');
      configOptions = await this.#projectConfigOptions(connection, created);
    } catch {
      // The client can still prompt, configure, list, or close the returned ID.
    }
    // Do not admit mutations while projection is pending, or resurrect ownership
    // if connection shutdown raced the successful Host creation.
    if (!this.#closing) this.#ownedSessionIds.add(sessionId);
    return { sessionId, ...(configOptions ? { configOptions } : {}) };
  }

  async #setConfigOption(
    params: SetSessionConfigOptionRequest & { readonly value: string },
    configuration?: AcpAttachmentConfiguration,
  ): Promise<SetSessionConfigOptionResponse> {
    const connection = await this.#getConnection('session.configuration.update');
    let committed: SessionCatalogProjection;
    try {
      committed = await updateRuntimeHostSession(
        connection,
        params.sessionId,
        (current) =>
          connection.request('session.configuration.update', {
            sessionId: params.sessionId,
            expectedRevision: current.revision,
            patch: createAcpSessionConfigPatch(params),
          }),
        {
          operation: 'session.configuration.update',
          assertRequestAllowed: () => {
            this.#assertOpen('session.configuration.update');
            this.#assertOwned(params.sessionId);
          },
        },
      );
    } catch (error) {
      throw requestErrorFromSessionUpdate(error, 'session.configuration.update');
    }
    const configOptions = await this.#projectConfigOptions(connection, committed);
    if (configuration)
      await this.#notifyConfiguration(params.sessionId, configuration, configOptions);
    return { configOptions };
  }

  #configurationIsLive(sessionId: string, configuration: AcpAttachmentConfiguration): boolean {
    return (
      !this.#closing &&
      this.#ownedSessionIds.has(sessionId) &&
      this.#attachmentConfigurations.get(sessionId) === configuration
    );
  }

  #queueConfiguration<T>(
    configuration: AcpAttachmentConfiguration,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Serialize asynchronous catalog projection and delivery, not Host frames:
    // session-channel/projector remain the only subscription ordering authority.
    // A local set emits its committed options before its response; subscription
    // refreshes observed during that set follow its notification in this queue.
    const result = configuration.tail.then(operation, operation);
    configuration.tail = result.catch(() => undefined);
    return result;
  }

  async #notifyConfiguration(
    sessionId: string,
    configuration: AcpAttachmentConfiguration,
    configOptions: SessionConfigOption[],
  ): Promise<void> {
    if (!this.#configurationIsLive(sessionId, configuration)) return;
    const options = JSON.stringify(configOptions);
    if (configuration.options === options) return;
    configuration.delivery = configuration.notify({
      sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions },
    });
    await configuration.delivery;
    configuration.options = options;
  }

  async #projectConfigOptions(
    connection: AcpSessionRegistryConnection,
    session: SessionCatalogProjection,
  ): Promise<SessionConfigOption[]> {
    let catalog;
    try {
      catalog = await readRuntimeHostConnectionCatalog(connection);
    } catch (error) {
      throw requestErrorFromRuntimeHost(error, 'connection.catalog.query');
    }
    const selectedConnection = catalog.connections.find(
      ({ connectionId }) => connectionId === session.llmConnectionId,
    );
    const selectedModel = selectedConnection?.catalogEntries.find(({ id }) => id === session.model);
    return projectAcpSessionConfigOptions(session, selectedModel?.thinkingLevels ?? []);
  }

  async #list(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const cursor = params.cursor == null ? undefined : decodeAcpSessionCursor(params.cursor);
    const requestedCwd = params.cwd == null ? undefined : await normalizeCwd(params.cwd);
    if (cursor && requestedCwd !== undefined && cursor.cwd !== requestedCwd) {
      throw RequestError.invalidParams(
        { reason: 'cursor_cwd_mismatch' },
        'cursor was created for a different cwd filter',
      );
    }
    const cwd = requestedCwd ?? cursor?.cwd ?? null;
    const connection = await this.#getConnection('session.catalog.query');
    let page;
    try {
      page = await readRuntimeHostSessionCatalogPage(
        connection,
        cursor ? { revision: cursor.revision, cursor: cursor.cursor } : undefined,
      );
    } catch (error) {
      if (error instanceof RuntimeHostSessionCatalogRevisionChangedError) {
        throw RequestError.invalidParams(
          { reason: 'stale_cursor' },
          'session catalog changed; restart listing from the first page',
        );
      }
      throw requestErrorFromRuntimeHost(error, 'session.catalog.query');
    }

    const sessions = page.sessions.flatMap((session) => {
      if ('kind' in session || (cwd !== null && session.workspace.hostCwd !== cwd)) return [];
      const updatedAt = isoTimestamp(session.activityAt);
      return [
        {
          sessionId: session.id,
          cwd: session.workspace.hostCwd,
          title: session.name,
          ...(updatedAt ? { updatedAt } : {}),
        },
      ];
    });
    return {
      sessions,
      ...(page.nextCursor
        ? { nextCursor: encodeAcpSessionCursor({ ...page.nextCursor, cwd }) }
        : {}),
    };
  }

  async #dispose(): Promise<void> {
    const sessionIds = new Set([...this.#activePrompts.keys(), ...this.#attachments.keys()]);
    const activePrompts = [...sessionIds].flatMap((sessionId) => [
      ...(this.#activePrompts.get(sessionId) ?? []),
    ]);
    const cancellations = [...sessionIds].map((sessionId) => this.#cancelSession(sessionId));
    for (const interactions of this.#attachmentInteractions.values()) interactions.close();
    this.#attachmentInteractions.clear();
    const attachments = [...this.#attachments.values()];
    this.#attachments.clear();
    const configurations = [...this.#attachmentConfigurations.values()];
    this.#attachmentConfigurations.clear();
    await Promise.allSettled(attachments.map(async (attachment) => (await attachment).close()));
    await Promise.allSettled(
      activePrompts.map(async (active) => {
        while (active.dispatchStarted && !active.startRequestSettled && !active.finished) {
          await this.#waitForPromptChange(active);
        }
      }),
    );
    const unknownAdmissions = activePrompts.filter((active) => {
      const observed = active.attachment?.snapshot.rootTurn;
      const hasStopIdentity =
        observed?.turnId === active.turnId || active.startedTurn !== undefined;
      return active.dispatchStarted && !active.admissionSettled && !hasStopIdentity;
    });
    if (unknownAdmissions.length > 0) {
      // At shutdown the attachment is already closed and each start request has
      // settled, leaving recovery/query as the only remaining fact source.
      // Close the owned connection so those reads cannot deadlock EOF cleanup.
      await Promise.allSettled([this.#closeOwnedConnection()]);
      for (const active of unknownAdmissions) {
        active.admissionSettled = true;
        this.#wake(active);
      }
    }
    await Promise.allSettled(cancellations);
    const mcps = [...this.#mcps.values()];
    this.#mcps.clear();
    await Promise.allSettled(mcps.map((mcp) => mcp.close()));
    await Promise.allSettled([this.#closeOwnedConnection()]);
    await Promise.allSettled([
      ...this.#inFlightOperations,
      ...configurations.map(({ tail }) => tail),
    ]);
    this.#ownedSessionIds.clear();
  }

  #closeOwnedConnection(): Promise<void> {
    const connection = this.#connection;
    const connectTask = this.#connectTask;
    if (!connection && !connectTask) return Promise.resolve();
    this.#connectionCloseTask ??= connection
      ? Promise.resolve().then(() => connection.close())
      : connectTask!.then(
          (connected) => connected.close(),
          () => undefined,
        );
    return this.#connectionCloseTask;
  }

  async #getConnection(
    operation: AcpSessionRegistryOperation,
  ): Promise<AcpSessionRegistryConnection> {
    this.#assertOpen(operation);
    if (this.#connection) return this.#connection;
    let connectController = this.#connectAbortController;
    if (!this.#connectTask) {
      connectController = new AbortController();
      this.#connectAbortController = connectController;
      this.#connectTask = Promise.resolve().then(() => {
        if (this.#closing) throw registryClosedError('connect');
        connectController!.signal.throwIfAborted();
        return this.#connect(connectController!.signal);
      });
    }
    const connectTask = this.#connectTask;
    let connection: AcpSessionRegistryConnection;
    try {
      connection = await connectTask;
    } catch {
      if (this.#connectTask === connectTask) this.#connectTask = undefined;
      if (this.#connectAbortController === connectController) {
        this.#connectAbortController = undefined;
      }
      if (this.#closing) throw registryClosedError('connect');
      throw RequestError.internalError(
        {
          source: 'runtime_host',
          operation: 'connect',
          code: 'connection_failed',
        },
        'Runtime Host connection failed',
      );
    }
    if (this.#connectAbortController === connectController) {
      this.#connectAbortController = undefined;
    }
    if (this.#closing) {
      await this.#closeOwnedConnection().catch(() => undefined);
      throw registryClosedError('connect');
    }
    this.#connection ??= connection;
    return this.#connection;
  }

  async #track<T>(operation: Promise<T>): Promise<T> {
    this.#inFlightOperations.add(operation);
    try {
      return await operation;
    } finally {
      this.#inFlightOperations.delete(operation);
    }
  }

  #assertOpen(operation: AcpSessionRegistryLifecycleOperation): void {
    if (!this.#closing) return;
    throw registryClosedError(operation);
  }
}

function unknownSessionError(): RequestError {
  return RequestError.invalidParams(
    { reason: 'unknown_session' },
    'Session is not owned by this ACP connection',
  );
}

function registryClosedError(operation: AcpSessionRegistryLifecycleOperation): RequestError {
  return RequestError.internalError(
    { source: 'runtime_host', operation, code: 'registry_closed' },
    'ACP session registry is closed',
  );
}

function validateNewSessionParams(params: NewSessionRequest): void {
  assertBoundedAbsoluteCwd(params.cwd);
  if ((params.additionalDirectories?.length ?? 0) > 0) {
    throw RequestError.invalidParams(
      { field: 'additionalDirectories', reason: 'unsupported' },
      'Additional directories are not supported by this ACP adapter yet',
    );
  }
}

function requestErrorFromConfigInput(error: unknown): RequestError {
  if (error instanceof AcpSessionConfigInputError) {
    return RequestError.invalidParams(
      { field: error.field, reason: error.reason },
      'Invalid Session configuration option',
    );
  }
  return RequestError.internalError(
    {
      source: 'adapter',
      operation: 'session.configuration.update',
      code: 'validation_failed',
    },
    'Session configuration validation failed',
  );
}

function requestErrorFromSessionUpdate(
  error: unknown,
  operation: AcpSessionRegistryOperation,
  extra: Record<string, unknown> = {},
): RequestError {
  if (error instanceof RequestError) return error;
  if (!(error instanceof RuntimeHostSessionUpdateError)) {
    return requestErrorFromRuntimeHost(error, operation, extra);
  }
  const common = { source: 'runtime_host', operation: error.operation, ...extra };
  switch (error.reason) {
    case 'not_found':
      return RequestError.invalidParams(
        { ...common, code: 'not_found' },
        'Runtime Host Session was not found',
      );
    case 'invalid_projection':
      return RequestError.internalError(
        { ...common, code: 'catalog_read_failure', reason: 'invalid_projection' },
        'Runtime Host returned an invalid Session lookup',
      );
    case 'unsupported_session_projection':
      return RequestError.internalError(
        { ...common, code: 'unsupported_session_projection' },
        'Runtime Host Session cannot be represented in ACP',
      );
    case 'revision_conflict':
      return RequestError.internalError(
        { ...common, code: 'revision_conflict', attempts: error.attempts },
        'Session configuration kept changing',
      );
  }
}

function requestErrorFromRuntimeHost(
  error: unknown,
  operation: AcpSessionRegistryOperation,
  extra: Record<string, unknown> = {},
): RequestError {
  const data = { ...runtimeHostErrorData(error, operation), ...extra };
  if (
    error instanceof RuntimeHostOperationError &&
    (error.code === 'invalid_request' || error.code === 'not_found')
  ) {
    return RequestError.invalidParams(data, 'Runtime Host rejected the request');
  }
  return RequestError.internalError(data, 'Runtime Host request failed');
}

function runtimeHostErrorData(error: unknown, operation: string): Record<string, unknown> {
  if (error instanceof RuntimeHostOperationError) {
    return {
      source: 'runtime_host',
      operation: error.operation,
      code: error.code,
    };
  }
  if (error instanceof RuntimeHostRequestInterruptedError) {
    return {
      source: 'runtime_host',
      operation: error.operation,
      code: 'request_interrupted',
      reason: error.reason,
      dispatch: error.dispatch,
    };
  }
  if (error instanceof RuntimeHostSubscriptionError) {
    return {
      source: 'runtime_host',
      operation,
      code: 'subscription_failure',
      reason: error.reason,
    };
  }
  if (error instanceof RuntimeHostCatalogReadError) {
    return {
      source: 'runtime_host',
      operation,
      code: 'catalog_read_failure',
      reason: error.reason,
    };
  }
  return { source: 'runtime_host', operation, code: 'internal_failure' };
}

interface AcpSessionCursor extends RuntimeHostSessionCatalogPageCursor {
  readonly cwd: string | null;
}

function encodeAcpSessionCursor(
  cursor: RuntimeHostSessionCatalogPageCursor & { readonly cwd: string | null },
): string {
  const encoded = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > ACP_SESSION_CURSOR_MAX_BYTES) {
    throw RequestError.internalError(
      {
        source: 'runtime_host',
        operation: 'session.catalog.query',
        code: 'cursor_too_large',
      },
      'Runtime Host cursor cannot be represented safely in ACP',
    );
  }
  return encoded;
}

function decodeAcpSessionCursor(encoded: string): AcpSessionCursor {
  try {
    if (encoded.length === 0 || Buffer.byteLength(encoded, 'utf8') > ACP_SESSION_CURSOR_MAX_BYTES) {
      throw new Error('cursor size is invalid');
    }
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) throw new Error('cursor encoding is invalid');
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('cursor body is invalid');
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      typeof record.revision !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(record.revision) ||
      typeof record.cursor !== 'string' ||
      record.cursor.length === 0 ||
      Buffer.byteLength(record.cursor, 'utf8') > SESSION_CATALOG_CURSOR_MAX_BYTES ||
      !validCursorCwd(record.cwd)
    ) {
      throw new Error('cursor fields are invalid');
    }
    return {
      revision: record.revision as RuntimeHostSessionCatalogPageCursor['revision'],
      cursor: record.cursor,
      cwd: record.cwd,
    };
  } catch {
    throw RequestError.invalidParams({ reason: 'invalid_cursor' }, 'cursor is invalid');
  }
}

function validCursorCwd(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      isAbsolute(value) &&
      normalize(value) === value &&
      Buffer.byteLength(value, 'utf8') <= SESSION_CATALOG_CWD_MAX_BYTES)
  );
}

async function normalizeCwd(cwd: string): Promise<string> {
  assertBoundedAbsoluteCwd(cwd);
  const lexical = normalize(cwd);
  try {
    return await realpath(lexical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return lexical;
    throw RequestError.internalError(
      {
        source: 'filesystem',
        operation: 'cwd.realpath',
        code: code ?? 'internal_failure',
      },
      'cwd could not be canonicalized',
    );
  }
}

function assertBoundedAbsoluteCwd(cwd: string): void {
  if (!isAbsolute(cwd)) {
    throw RequestError.invalidParams(
      { field: 'cwd', reason: 'must_be_absolute' },
      'cwd must be an absolute path',
    );
  }
  if (Buffer.byteLength(cwd, 'utf8') > SESSION_CATALOG_CWD_MAX_BYTES) {
    throw RequestError.invalidParams(
      { field: 'cwd', reason: 'too_large' },
      'cwd exceeds the Runtime Host path limit',
    );
  }
}

function isoTimestamp(timestamp: number): string | undefined {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
