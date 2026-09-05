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
import type { StoredMessage } from '@maka/core/session';
import {
  readRuntimeHostConnectionCatalog,
  readRuntimeHostSessionCatalogPage,
  RuntimeHostCatalogReadError,
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  RuntimeHostSessionCatalogRevisionChangedError,
  type RuntimeHostReconnectingConnection,
  type RuntimeHostSessionCatalogPageCursor,
} from '@maka/runtime-host/client';
import {
  SESSION_CATALOG_CURSOR_MAX_BYTES,
  SESSION_CATALOG_CWD_MAX_BYTES,
  HOST_OPERATION_SPECS,
  type SessionCatalogProjection,
  type SessionContinuitySnapshot,
} from '@maka/runtime-host/protocol';
import { RuntimeHostSessionChannel } from '../runtime-host-session-channel.js';
import {
  RuntimeHostSessionUpdateError,
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
    'hostEpoch' | 'request' | 'openSessionSubscription' | 'openSessionSubscriptionOnce' | 'close'
  > {}

export interface AcpSessionAttachment {
  readonly snapshot: SessionContinuitySnapshot;
  eventsForTurn(turnId: string): AsyncIterable<SessionEvent>;
  failTurn(turnId: string, error: unknown): void;
  close(): Promise<void>;
}

export interface AcpSessionAttachmentOpenInput {
  readonly connection: AcpSessionRegistryConnection;
  readonly sessionId: string;
  readonly onSnapshotChanged: (snapshot: SessionContinuitySnapshot) => void;
  readonly onTranscriptReplaced: (turnId: string, messages: readonly StoredMessage[]) => void;
  readonly onFailed: (error: Error) => void;
}

export interface AcpPromptContext {
  readonly signal: AbortSignal;
  readonly notify: (notification: SessionNotification) => Promise<void>;
}

export interface AcpSessionRegistryOptions {
  readonly connect: (signal: AbortSignal) => Promise<AcpSessionRegistryConnection>;
  readonly newSessionId?: () => string;
  readonly newTurnId?: () => string;
  readonly openSessionAttachment?: (
    input: AcpSessionAttachmentOpenInput,
  ) => Promise<AcpSessionAttachment>;
}

interface ActiveAcpPrompt {
  readonly sessionId: string;
  readonly turnId: string;
  readonly mapper: AcpSessionEventMapper;
  readonly waiters: Set<() => void>;
  attachment?: AcpSessionAttachment;
  dispatchStarted: boolean;
  startSettled: boolean;
  startSucceeded: boolean;
  observationSettled: boolean;
  cancelled: boolean;
  finished: boolean;
  stopTask?: Promise<void>;
}

/** Owns all Runtime Host resources associated with one ACP connection. */
export class AcpSessionRegistry {
  readonly #connect: (signal: AbortSignal) => Promise<AcpSessionRegistryConnection>;
  readonly #newSessionId: () => string;
  readonly #newTurnId: () => string;
  readonly #openSessionAttachment: (
    input: AcpSessionAttachmentOpenInput,
  ) => Promise<AcpSessionAttachment>;
  readonly #inFlightOperations = new Set<Promise<unknown>>();
  readonly #ownedSessionIds = new Set<string>();
  readonly #attachments = new Map<string, Promise<AcpSessionAttachment>>();
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
    this.#openSessionAttachment = options.openSessionAttachment ?? openRuntimeHostSessionAttachment;
  }

  async create(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.#assertOpen('session.create');
    validateNewSessionParams(params);
    return this.#track(this.#create(params));
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
    return this.#track(this.#setConfigOption(params));
  }

  async prompt(params: PromptRequest, context: AcpPromptContext): Promise<PromptResponse> {
    this.#assertOpen('turn.start');
    this.#assertOwned(params.sessionId);
    return this.#track(this.#prompt(params, context));
  }

  async cancel(params: CancelNotification): Promise<void> {
    if (this.#closing) return;
    const active = [...(this.#activePrompts.get(params.sessionId) ?? [])];
    await Promise.allSettled(active.map((prompt) => this.#cancelPrompt(prompt)));
  }

  async close(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    this.#assertOpen('session.close');
    const existing = this.#sessionCloseTasks.get(params.sessionId);
    if (existing) return existing;
    this.#assertOwned(params.sessionId);
    this.#ownedSessionIds.delete(params.sessionId);
    const task = this.#track(this.#closeSession(params.sessionId));
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
    this.#disposeTask ??= this.#dispose();
    return this.#disposeTask;
  }

  async #prompt(params: PromptRequest, context: AcpPromptContext): Promise<PromptResponse> {
    const turnId = this.#newTurnId();
    const active: ActiveAcpPrompt = {
      sessionId: params.sessionId,
      turnId,
      mapper: new AcpSessionEventMapper({ sessionId: params.sessionId, notify: context.notify }),
      waiters: new Set(),
      dispatchStarted: false,
      startSettled: false,
      startSucceeded: false,
      observationSettled: false,
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
      if (active.cancelled) return { stopReason: await active.mapper.cancel() };

      const connection = await this.#getConnection('subscription.open');
      let attachment: AcpSessionAttachment;
      try {
        attachment = await this.#ensureAttachment(params.sessionId, connection);
      } catch (error) {
        if (active.cancelled) return { stopReason: await active.mapper.cancel() };
        throw error;
      }
      active.attachment = attachment;
      this.#wake(active);
      if (active.cancelled) return { stopReason: await active.mapper.cancel() };

      const observation = this.#consumePromptEvents(active, attachment.eventsForTurn(turnId));
      // Mark the observer as handled immediately: turn.start may still be in flight
      // when the live subscription reports a failure.
      void observation.catch(() => undefined);
      active.dispatchStarted = true;
      this.#wake(active);
      try {
        const result = await connection.request('turn.start', startInput);
        active.startSettled = true;
        active.startSucceeded = result.kind === 'started';
        this.#wake(active);
        if (result.kind === 'blocked') {
          const error = new Error('Runtime Host blocked the requested Turn');
          attachment.failTurn(turnId, error);
          throw error;
        }
      } catch (error) {
        active.startSettled = true;
        this.#wake(active);
        attachment.failTurn(turnId, error);
        if (!active.cancelled) throw requestErrorFromRuntimeHost(error, 'turn.start');
      }

      if (active.cancelled) {
        await active.stopTask;
        void observation.catch(() => undefined);
        return { stopReason: await active.mapper.cancel() };
      }
      const stopReason = await observation;
      return { stopReason };
    } finally {
      context.signal.removeEventListener('abort', onAbort);
      active.finished = true;
      this.#wake(active);
      this.#removeActivePrompt(active);
    }
  }

  async #consumePromptEvents(
    active: ActiveAcpPrompt,
    events: AsyncIterable<SessionEvent>,
  ): Promise<StopReason> {
    try {
      for await (const event of events) {
        const terminal = await active.mapper.accept(event);
        if (terminal) {
          active.observationSettled = true;
          this.#wake(active);
          return terminal;
        }
      }
      if (active.cancelled) return active.mapper.cancel();
      throw new Error('Runtime Host Turn observation ended without a terminal event');
    } catch (error) {
      active.observationSettled = true;
      this.#wake(active);
      if (active.cancelled) return active.mapper.cancel();
      throw error;
    } finally {
      active.observationSettled = true;
      this.#wake(active);
    }
  }

  async #cancelPrompt(active: ActiveAcpPrompt): Promise<void> {
    active.cancelled = true;
    active.stopTask ??= this.#stopPromptWhenObservable(active);
    await Promise.all([active.mapper.cancel(), active.stopTask]);
  }

  async #stopPromptWhenObservable(active: ActiveAcpPrompt): Promise<void> {
    if (!active.dispatchStarted) return;
    while (!active.finished) {
      const root = active.attachment?.snapshot.rootTurn;
      if (root?.turnId === active.turnId) {
        if (isTerminalRootTurn(root)) return;
        const connection = this.#connection;
        if (!connection) return;
        await connection.request('turn.stop', {
          sessionId: active.sessionId,
          turnId: root.turnId,
          runId: root.runId,
        });
        return;
      }
      if ((active.startSettled && !active.startSucceeded) || active.observationSettled) return;
      await this.#waitForPromptChange(active);
    }
  }

  async #ensureAttachment(
    sessionId: string,
    connection: AcpSessionRegistryConnection,
  ): Promise<AcpSessionAttachment> {
    const existing = this.#attachments.get(sessionId);
    if (existing) return existing;
    let task!: Promise<AcpSessionAttachment>;
    let attachment: AcpSessionAttachment | undefined;
    let earlyFailure: Error | undefined;
    task = this.#openSessionAttachment({
      connection,
      sessionId,
      onSnapshotChanged: () => this.#wakeSession(sessionId),
      onTranscriptReplaced: (turnId, messages) => {
        for (const active of this.#activePrompts.get(sessionId) ?? []) {
          if (active.turnId === turnId) {
            void active.mapper.replaceTranscript(turnId, messages).catch(() => undefined);
          }
        }
      },
      onFailed: (error) => {
        if (!attachment) {
          earlyFailure = error;
          return;
        }
        this.#retireFailedAttachment(sessionId, task, attachment, error);
      },
    })
      .then((opened) => {
        attachment = opened;
        if (earlyFailure) {
          this.#retireFailedAttachment(sessionId, task, opened, earlyFailure);
        }
        if (this.#closing || !this.#ownedSessionIds.has(sessionId)) {
          return opened.close().then(() => {
            throw this.#closing ? registryClosedError('subscription.open') : unknownSessionError();
          });
        }
        return opened;
      })
      .catch((error: unknown) => {
        if (this.#attachments.get(sessionId) === task) this.#attachments.delete(sessionId);
        if (error instanceof RequestError) throw error;
        throw requestErrorFromRuntimeHost(error, 'subscription.open');
      });
    this.#attachments.set(sessionId, task);
    return task;
  }

  #retireFailedAttachment(
    sessionId: string,
    task: Promise<AcpSessionAttachment>,
    attachment: AcpSessionAttachment,
    error: Error,
  ): void {
    if (this.#attachments.get(sessionId) === task) this.#attachments.delete(sessionId);
    for (const active of this.#activePrompts.get(sessionId) ?? []) {
      if (active.attachment !== attachment) continue;
      active.observationSettled = true;
      attachment.failTurn(active.turnId, error);
      this.#wake(active);
    }
    void attachment.close().catch(() => undefined);
  }

  async #closeSession(sessionId: string): Promise<CloseSessionResponse> {
    const active = [...(this.#activePrompts.get(sessionId) ?? [])];
    const cancellation = await Promise.allSettled(
      active.map((prompt) => this.#cancelPrompt(prompt)),
    );
    const attachmentTask = this.#attachments.get(sessionId);
    this.#attachments.delete(sessionId);
    let closeError: unknown;
    if (attachmentTask) {
      try {
        const attachment = await attachmentTask;
        await attachment.close();
      } catch (error) {
        closeError = error;
      }
    }
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

  async #create(params: NewSessionRequest): Promise<NewSessionResponse> {
    const connection = await this.#getConnection('session.create');
    const sessionId = this.#newSessionId();
    let result;
    try {
      result = await connection.request('session.create', {
        sessionId,
        workspace: { kind: 'host_path', path: params.cwd },
        modelTarget: { kind: 'default' },
      });
    } catch (error) {
      throw requestErrorFromRuntimeHost(error, 'session.create', { sessionId });
    }
    let created: SessionCatalogProjection;
    try {
      created = requireRuntimeHostSessionProjection(result, 'session.create');
    } catch (error) {
      throw requestErrorFromSessionUpdate(error, 'session.create', { sessionId });
    }
    const configOptions = await this.#projectConfigOptions(connection, created);
    this.#ownedSessionIds.add(sessionId);
    return { sessionId, configOptions };
  }

  async #setConfigOption(
    params: SetSessionConfigOptionRequest & { readonly value: string },
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
          assertRequestAllowed: () => this.#assertOpen('session.configuration.update'),
        },
      );
    } catch (error) {
      throw requestErrorFromSessionUpdate(error, 'session.configuration.update');
    }
    return { configOptions: await this.#projectConfigOptions(connection, committed) };
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
    const active = [...this.#activePrompts.values()].flatMap((prompts) => [...prompts]);
    const cancellations = active.map((prompt) => this.#cancelPrompt(prompt));
    const attachments = [...this.#attachments.values()];
    this.#attachments.clear();
    await Promise.allSettled(attachments.map(async (attachment) => (await attachment).close()));
    await Promise.allSettled(cancellations);
    await Promise.allSettled([this.#closeOwnedConnection()]);
    await Promise.allSettled([...this.#inFlightOperations]);
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

async function openRuntimeHostSessionAttachment(
  input: AcpSessionAttachmentOpenInput,
): Promise<AcpSessionAttachment> {
  const opened = await RuntimeHostSessionChannel.open({
    connection: input.connection,
    openInitialSessionSubscription: input.connection.openSessionSubscriptionOnce.bind(
      input.connection,
    ),
    sessionId: input.sessionId,
    now: Date.now,
    onTurnStarted: () => undefined,
    onRuntimeResourceChanged: () => undefined,
    onInteractionPending: () => undefined,
    onInteractionResolved: () => undefined,
    onTranscriptSettlement: () => undefined,
    onTranscriptReplaced: input.onTranscriptReplaced,
    onGoalChanged: () => undefined,
    onSnapshotChanged: input.onSnapshotChanged,
    onFailed: input.onFailed,
    onRecovered: () => undefined,
  });
  opened.channel.activate();
  return opened.channel;
}

function isTerminalRootTurn(root: NonNullable<SessionContinuitySnapshot['rootTurn']>): boolean {
  return root.status === 'completed' || root.status === 'failed' || root.status === 'cancelled';
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
  if (params.mcpServers.length > 0) {
    throw RequestError.invalidParams(
      { field: 'mcpServers', reason: 'unsupported' },
      'MCP servers are not supported by this ACP adapter yet',
    );
  }
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
