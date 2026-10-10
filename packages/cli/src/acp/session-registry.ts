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
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk';
import type { McpConfigFile } from '@maka/core/mcp';
import {
  isRuntimeHostTerminalTurn,
  type RuntimeHostTerminalTurn,
} from '@maka/runtime-host/adapter';
import {
  abortable,
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
  type ArtifactQueryInput,
  type ArtifactQueryResult,
  type ArtifactIngestInput,
  type ArtifactIngestResult,
  type ArtifactDeleteInput,
  type ArtifactDeleteResult,
  type MemoryQueryInput,
  type MemoryQueryResult,
  type MemoryMutateInput,
  type MemoryMutateResult,
  type OperationInput,
  type OperationOutput,
  type SessionCatalogProjection,
  type TurnSnapshot,
  type TurnResumePlan,
  type SessionConversationCopyInput,
  type SessionConversationCopyResult,
  type SessionRevisionAbandonInput,
  type SessionRevisionAbandonResult,
  type SessionTurnsQueryInput,
  type SessionTurnsQueryResult,
  type GoalQueryInput,
  type GoalQueryResult,
  type GoalArmInput,
  type GoalArmResult,
  type GoalControlInput,
  type GoalControlResult,
  type PlanQueryInput,
  type PlanQueryResult,
  type PlanControlInput,
  type PlanControlResult,
  type PlanTurnStartInput,
  type PlanTurnStartResult,
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
import { mapAcpPromptContent, publishAcpPromptAttachments } from './prompt-content.js';
import { AcpSessionMcp, createAcpMcpConfig, type AcpMcpConnection } from './session-mcp.js';
import { AcpSessionInteractions, type AcpInteractionClient } from './session-interactions.js';
import { AcpTurnObservation, AcpAdmittedTurnObservation } from './turn-observation.js';
import {
  AcpGoalPlanOperations,
  type GoalPlanOperationName,
  type PreparedGoalPlanOperation,
} from './goal-plan-operations.js';
import {
  AcpSessionDomainObservation,
  type AcpGoalStatus,
  type AcpPlanChanged,
} from './session-domain-observation.js';

const ACP_SESSION_CURSOR_MAX_BYTES = 8 * 1024;
const ADMISSION_QUERY_MAX_ATTEMPTS = 5;
const ADMISSION_QUERY_TIMEOUT_MS = 1_000;
const ADMISSION_QUERY_RETRY_MS = 25;
const EXTENSION_REQUEST_TIMEOUT_MS = 30_000;
const ARTIFACT_CLEANUP_TIMEOUT_MS = 5_000;
const ARTIFACT_UPLOAD_TTL_MS = 5 * 60_000;
const MAX_TRACKED_ARTIFACT_UPLOADS = 64;
const TURN_STOP_TIMEOUT_MS = 30_000;
const COPY_RECONCILIATION_TIMEOUT_MS = 30_000;
const UNAVAILABLE_INTERACTION_CLIENT: AcpInteractionClient = {
  capabilities: {},
  requestPermission: async () => {
    throw RequestError.methodNotFound('session/request_permission');
  },
  createElicitation: async () => {
    throw RequestError.methodNotFound('elicitation/create');
  },
};

interface ArtifactUploadTracking {
  touchedAt: number;
  pendingRequests: number;
  mayBeOpen: boolean;
}

function artifactUploadKey(sessionId: string, uploadId: string): string {
  return JSON.stringify([sessionId, uploadId]);
}

type AcpSessionRegistryOperation =
  | 'connection.catalog.query'
  | 'session.create'
  | 'session.catalog.query'
  | 'session.configuration.update'
  | 'artifact.ingest'
  | 'artifact.query'
  | 'artifact.delete'
  | 'memory.query'
  | 'memory.mutate'
  | 'subscription.open'
  | 'turn.start'
  | 'turn.stop'
  | 'turn.query'
  | 'turn.resume.query'
  | 'turn.resume.start'
  | 'session.turns.query'
  | 'session.branch.create'
  | 'session.revision.create'
  | 'session.revision.abandon'
  | GoalPlanOperationName;
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

export interface AcpAttachedTurnStatus {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'cancelled' | 'observation_failed';
  readonly failureClass?: string;
}

export interface AcpLoadContext extends AcpPromptContext {
  readonly notifyTurnStatus?: (status: AcpAttachedTurnStatus) => Promise<void>;
  readonly notifyGoalStatus?: (status: AcpGoalStatus) => Promise<void>;
  readonly notifyPlanChanged?: (status: AcpPlanChanged) => Promise<void>;
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

interface HistoryReplayDelivery {
  readonly textByMessage: Map<string, string>;
  readonly otherUpdates: Set<string>;
}

interface AcpExternalContextLease {
  readonly context: AcpLoadContext;
  previous?: AcpExternalContextLease;
  valid: boolean;
}

interface AcpContextReplacement {
  rollback(): void;
  commit(): void;
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
  readonly #domainObservations = new Map<string, AcpSessionDomainObservation>();
  readonly #goalPlan: AcpGoalPlanOperations;
  readonly #attachments = new Map<string, Promise<RuntimeHostSessionChannel>>();
  readonly #attachmentOpenControllers = new Map<string, AbortController>();
  readonly #attachmentConfigurations = new Map<string, AcpAttachmentConfiguration>();
  readonly #pendingConfigSets = new Map<string, Set<Promise<unknown>>>();
  readonly #attachmentWaiters = new Map<string, Set<object>>();
  readonly #turnObservations = new Map<string, Map<string, AcpTurnObservation>>();
  readonly #pendingPlanAdmissions = new Map<
    AcpAdmittedTurnObservation,
    { users: number; retained: boolean }
  >();
  readonly #discardedAttachments = new WeakSet<RuntimeHostSessionChannel>();
  readonly #externalObservationContexts = new Map<string, AcpLoadContext>();
  readonly #externalContextLeases = new Map<string, AcpExternalContextLease>();
  readonly #sessionCloseTasks = new Map<string, Promise<CloseSessionResponse>>();
  readonly #artifactUploads = new Map<string, Map<string, ArtifactUploadTracking>>();
  readonly #artifactOperations = new Map<string, Set<Promise<unknown>>>();
  // Retain cleanup waits across Host replacement so a late abort cannot race a reused ID.
  readonly #artifactCleanupTasks = new Map<string, Promise<void>>();
  #artifactConnectionIdentity?: string;
  #artifactConnectionDisposer?: () => void;
  readonly #sessionCloseGenerations = new Map<string, number>();
  readonly #sessionLoadTails = new Map<string, Promise<unknown>>();
  readonly #sessionLoadControllers = new Map<string, AbortController>();
  readonly #historyReplays = new Set<string>();
  readonly #historyReplayDelivery = new Map<string, HistoryReplayDelivery>();
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
    this.#goalPlan = new AcpGoalPlanOperations({
      prepare: (sessionId, context, turnId, observe) =>
        this.#prepareGoalPlan(sessionId, context, turnId, observe),
      assertCurrent: (sessionId) => {
        this.#assertOpen('subscription.open');
        this.#assertOwned(sessionId);
      },
      mapError: (error, operation, extra) => requestErrorFromRuntimeHost(error, operation, extra),
    });
  }

  goalQuery(input: GoalQueryInput, context: AcpLoadContext): Promise<GoalQueryResult> {
    return this.#track(this.#goalPlan.goalQuery(input, context));
  }
  goalArm(input: GoalArmInput, context: AcpLoadContext): Promise<GoalArmResult> {
    return this.#track(this.#goalPlan.goalArm(input, context));
  }
  goalControl(input: GoalControlInput, context: AcpLoadContext): Promise<GoalControlResult> {
    return this.#track(this.#goalPlan.goalControl(input, context));
  }
  planQuery(input: PlanQueryInput, context: AcpLoadContext): Promise<PlanQueryResult> {
    return this.#track(this.#goalPlan.planQuery(input, context));
  }
  planControl(input: PlanControlInput, context: AcpLoadContext): Promise<PlanControlResult> {
    return this.#track(this.#goalPlan.planControl(input, context));
  }
  planTurnStart(input: PlanTurnStartInput, context: AcpLoadContext): Promise<PlanTurnStartResult> {
    return this.#track(this.#goalPlan.planTurnStart(input, context));
  }

  async #prepareGoalPlan(
    sessionId: string,
    context: AcpLoadContext,
    turnId?: string,
    observe = true,
  ): Promise<PreparedGoalPlanOperation> {
    this.#assertOpen('subscription.open');
    this.#assertOwned(sessionId);
    context.signal.throwIfAborted();
    const generation = this.#sessionCloseGenerations.get(sessionId) ?? 0;
    const connection = await this.#getConnection('subscription.open');
    this.#assertOwned(sessionId);
    context.signal.throwIfAborted();
    if (!observe) return { connection, commit: () => undefined, rollback: () => undefined };
    const restoreContext = this.#installExternalContext(sessionId, context);
    const restoreClient = this.#attachmentInteractions
      .get(sessionId)
      ?.setClient(context.interactions ?? UNAVAILABLE_INTERACTION_CLIENT);
    const creatingAttachment = !this.#attachments.has(sessionId);
    let observation: AcpAdmittedTurnObservation | undefined;
    let observedReplay = false;
    let admissionFinished = false;
    let attachment: RuntimeHostSessionChannel | undefined;
    const finishAdmission = (retain: boolean, error?: unknown) => {
      if (!observation || admissionFinished) return;
      admissionFinished = true;
      const state = this.#pendingPlanAdmissions.get(observation);
      if (!state) return;
      state.retained ||= retain;
      state.users -= 1;
      if (state.users > 0) return;
      this.#pendingPlanAdmissions.delete(observation);
      if (state.retained) return;
      observation.failStartRequest(error);
      observation.dispose();
      this.#removeTurnObservation(observation);
      if (error && turnId) attachment?.failTurn(turnId, error);
    };
    const rollback = (error?: unknown) => {
      finishAdmission(false, error);
      restoreContext.rollback();
      restoreClient?.rollback();
      if (
        creatingAttachment &&
        !this.#hasAttachmentConsumers(sessionId) &&
        !this.#turnObservations.get(sessionId)?.size &&
        !this.#externalObservationContexts.has(sessionId)
      ) {
        const task = this.#detachAttachment(sessionId);
        void task?.then(
          (channel) => channel.close(),
          () => undefined,
        );
      }
    };
    try {
      const prepared = await this.#prepareExternalObservation(
        sessionId,
        context,
        connection,
        'subscription.open',
        turnId,
      );
      attachment = prepared.attachment;
      observation = prepared.observation;
      observedReplay = prepared.observedReplay ?? false;
      if (observation) {
        const state = this.#pendingPlanAdmissions.get(observation) ?? {
          users: 0,
          retained: false,
        };
        state.users += 1;
        this.#pendingPlanAdmissions.set(observation, state);
      }
      if ((this.#sessionCloseGenerations.get(sessionId) ?? 0) !== generation)
        throw unknownSessionError();
      if (context.notifyGoalStatus || context.notifyPlanChanged) {
        this.#domainObservations.get(sessionId)?.initialize(attachment.snapshot.goal);
      }
      return {
        connection,
        ...(observedReplay ? { observedReplay } : {}),
        ...(observation ? { observation } : {}),
        ...(observation
          ? { reconcileAdmission: () => this.#queryPromptAdmission(observation!, connection) }
          : {}),
        ...(observation
          ? {
              cancelObservation: () => {
                const state = this.#pendingPlanAdmissions.get(observation!);
                if (state?.users === 1 && !state.retained)
                  void this.#cancelPrompt(observation!).catch(() => undefined);
              },
            }
          : {}),
        commit: () => {
          finishAdmission(true);
          restoreContext.commit();
          restoreClient?.commit();
        },
        rollback,
      };
    } catch (error) {
      rollback(error);
      if (error instanceof RequestError) throw error;
      throw requestErrorFromRuntimeHost(error, 'subscription.open');
    }
  }

  /** Shared non-prompt preparation for explicit Turn resume and Plan admission. */
  async #prepareExternalObservation(
    sessionId: string,
    context: AcpLoadContext,
    connection: AcpSessionRegistryConnection,
    operation: 'subscription.open' | 'turn.resume.start',
    turnId?: string,
  ): Promise<{
    attachment: RuntimeHostSessionChannel;
    observation?: AcpAdmittedTurnObservation;
    observedReplay?: boolean;
  }> {
    await this.#mcps.get(sessionId)?.ready(context.signal);
    const attachment = await this.#ensureAttachment(sessionId, connection, context);
    context.signal.throwIfAborted();
    this.#assertOpen(operation);
    this.#assertOwned(sessionId);
    if (!turnId) return { attachment };
    const root = attachment.snapshot.rootTurn;
    if (root?.turnId === turnId && isRuntimeHostTerminalTurn(root))
      return { attachment, observedReplay: true };
    const observation = await this.#adoptTurn(sessionId, turnId, attachment, true);
    if (!observation) throw registryClosedError(operation);
    // Load/resume already observes an admitted Host Turn without local admission
    // bookkeeping. Let the Host validate the replay while preserving that sole
    // consumer, including when this request is rejected or its result is lost.
    if (!(observation instanceof AcpAdmittedTurnObservation))
      return { attachment, observedReplay: true };
    return { attachment, observation };
  }

  async create(params: NewSessionRequest, signal?: AbortSignal): Promise<NewSessionResponse> {
    this.#assertOpen('session.create');
    validateNewSessionParams(params);
    const mcpConfig = createAcpMcpConfig(params);
    return this.#track(this.#create(params, mcpConfig, signal));
  }

  async load(params: LoadSessionRequest, context: AcpLoadContext): Promise<LoadSessionResponse> {
    this.#assertOpen('subscription.open');
    validateNewSessionParams(params);
    const mcpConfig = createAcpMcpConfig(params);
    await this.#sessionCloseTasks.get(params.sessionId)?.catch(() => undefined);
    this.#assertOpen('subscription.open');
    const generation = this.#sessionCloseGenerations.get(params.sessionId) ?? 0;
    return this.#track(
      this.#queueLoad(params.sessionId, () =>
        this.#load(params, context, mcpConfig, true, generation),
      ),
    );
  }

  async resume(
    params: ResumeSessionRequest,
    context: AcpLoadContext,
  ): Promise<ResumeSessionResponse> {
    this.#assertOpen('subscription.open');
    validateNewSessionParams(params);
    const mcpConfig = createAcpMcpConfig({ ...params, mcpServers: params.mcpServers ?? [] });
    await this.#sessionCloseTasks.get(params.sessionId)?.catch(() => undefined);
    this.#assertOpen('subscription.open');
    const generation = this.#sessionCloseGenerations.get(params.sessionId) ?? 0;
    return this.#track(
      this.#queueLoad(params.sessionId, () =>
        this.#load(params, context, mcpConfig, false, generation),
      ),
    );
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

  async resumeTurn(
    params: { sessionId: string; sourceRunId?: string; expectedRuntimeEventHighWater?: number },
    context: AcpLoadContext,
  ): Promise<
    | { kind: 'parked'; plan: Extract<TurnResumePlan, { disposition: 'parked' }> }
    | {
        kind: 'started';
        turn: TurnSnapshot;
        sourceRunId: string;
        sourceRuntimeEventHighWater: number;
      }
  > {
    this.#assertOpen('turn.resume.query');
    this.#assertOwned(params.sessionId);
    return this.#track(this.#resumeTurn(params, context));
  }

  async queryCopySource(
    params: SessionTurnsQueryInput,
  ): Promise<SessionTurnsQueryResult & { expectedSourceRevision: number }> {
    this.#assertOpen('session.turns.query');
    this.#assertOwned(params.sessionId);
    return this.#track(this.#queryCopySource(params));
  }

  async #queryCopySource(
    params: SessionTurnsQueryInput,
  ): Promise<SessionTurnsQueryResult & { expectedSourceRevision: number }> {
    const connection = await this.#getConnection('session.turns.query');
    this.#assertOwned(params.sessionId);
    let session;
    try {
      session = await getRuntimeHostSession(connection, params.sessionId);
    } catch (error) {
      throw requestErrorFromSessionUpdate(error, 'session.catalog.query');
    }
    if (!session) throw unknownSessionError();
    this.#assertOwned(params.sessionId);
    try {
      const page = await connection.request('session.turns.query', params);
      this.#assertOwned(params.sessionId);
      // Read the revision before the page: concurrent source changes leave a
      // stale CAS token, which Host rejects instead of silently copying new data.
      return { ...page, expectedSourceRevision: session.revision };
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw requestErrorFromRuntimeHost(error, 'session.turns.query');
    }
  }

  async branch(params: SessionConversationCopyInput): Promise<SessionConversationCopyResult> {
    return this.#track(this.#copySession('session.branch.create', params));
  }

  async createRevision(
    params: SessionConversationCopyInput,
  ): Promise<SessionConversationCopyResult> {
    return this.#track(this.#copySession('session.revision.create', params));
  }

  async abandonRevision(
    params: SessionRevisionAbandonInput,
  ): Promise<SessionRevisionAbandonResult> {
    this.#assertOpen('session.revision.abandon');
    this.#assertOwned(params.targetSessionId);
    const task = this.#track(this.#abandonRevision(params));
    return task;
  }

  async close(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    this.#assertOpen('session.close');
    const existing = this.#sessionCloseTasks.get(params.sessionId);
    if (existing) return existing;
    if (
      !this.#ownedSessionIds.has(params.sessionId) &&
      !this.#sessionLoadTails.has(params.sessionId)
    ) {
      throw unknownSessionError();
    }
    this.#sessionCloseGenerations.set(
      params.sessionId,
      (this.#sessionCloseGenerations.get(params.sessionId) ?? 0) + 1,
    );
    this.#sessionLoadControllers.get(params.sessionId)?.abort();
    this.#ownedSessionIds.delete(params.sessionId);
    this.#historyReplayDelivery.delete(params.sessionId);
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

  async artifactQuery(input: ArtifactQueryInput): Promise<ArtifactQueryResult> {
    return this.#artifactRequest('artifact.query', input);
  }

  async artifactIngest(input: ArtifactIngestInput): Promise<ArtifactIngestResult> {
    return this.#artifactRequest('artifact.ingest', input);
  }

  async artifactDelete(input: ArtifactDeleteInput): Promise<ArtifactDeleteResult> {
    return this.#artifactRequest('artifact.delete', input);
  }

  async memoryQuery(input: MemoryQueryInput): Promise<MemoryQueryResult> {
    return this.#hostRequest('memory.query', input);
  }

  async memoryMutate(input: MemoryMutateInput): Promise<MemoryMutateResult> {
    const sessionId =
      'scope' in input && input.scope.kind === 'session' ? input.scope.sessionId : undefined;
    if (sessionId) this.#assertOwned(sessionId);
    return this.#hostRequest(
      'memory.mutate',
      input,
      sessionId ? () => this.#assertOwned(sessionId) : undefined,
    );
  }

  #artifactRequest<Operation extends 'artifact.query' | 'artifact.ingest' | 'artifact.delete'>(
    operation: Operation,
    input: OperationInput<Operation> & { readonly sessionId: string },
  ): Promise<OperationOutput<Operation>> {
    this.#assertOpen(operation);
    this.#assertOwned(input.sessionId);
    const request = this.#hostRequest(operation, input, () => this.#assertOwned(input.sessionId));
    let pending = this.#artifactOperations.get(input.sessionId);
    if (!pending) {
      pending = new Set();
      this.#artifactOperations.set(input.sessionId, pending);
    }
    pending.add(request);
    void request
      .finally(() => {
        pending.delete(request);
        if (pending.size === 0) this.#artifactOperations.delete(input.sessionId);
      })
      .catch(() => undefined);
    return request;
  }

  async #hostRequest<
    Operation extends
      | 'artifact.query'
      | 'artifact.ingest'
      | 'artifact.delete'
      | 'memory.query'
      | 'memory.mutate',
  >(
    operation: Operation,
    input: OperationInput<Operation>,
    beforeDispatch?: () => void,
  ): Promise<OperationOutput<Operation>> {
    this.#assertOpen(operation);
    return this.#track(
      (async () => {
        let trackedIngest: ArtifactUploadTracking | undefined;
        try {
          const connection = await this.#getConnection(operation);
          this.#assertOpen(operation);
          beforeDispatch?.();
          if (operation === 'artifact.ingest') {
            const upload = input as ArtifactIngestInput;
            let cleaning: Promise<void> | undefined;
            while (
              (cleaning = this.#artifactCleanupTasks.get(
                artifactUploadKey(upload.sessionId, upload.uploadId),
              ))
            ) {
              await cleaning;
              this.#assertOpen(operation);
              beforeDispatch?.();
            }
            if (upload.kind === 'begin') {
              this.#watchArtifactConnection(connection);
              let uploads = this.#artifactUploads.get(upload.sessionId);
              if (!uploads) {
                uploads = new Map();
                this.#artifactUploads.set(upload.sessionId, uploads);
              }
              if (!uploads.has(upload.uploadId) && uploads.size >= MAX_TRACKED_ARTIFACT_UPLOADS) {
                await this.#pruneExpiredArtifactUploads(connection, upload.sessionId, uploads);
                this.#assertOpen(operation);
                beforeDispatch?.();
                if (this.#artifactUploads.get(upload.sessionId) !== uploads) {
                  uploads = this.#artifactUploads.get(upload.sessionId) ?? new Map();
                  this.#artifactUploads.set(upload.sessionId, uploads);
                }
              }
              if (!uploads.has(upload.uploadId) && uploads.size >= MAX_TRACKED_ARTIFACT_UPLOADS) {
                throw RequestError.internalError(
                  { source: 'adapter', operation, code: 'upload_tracking_capacity' },
                  'Too many unresolved Artifact uploads',
                );
              }
              // Remember before dispatch: an interrupted response can hide an opened upload.
              let state = uploads.get(upload.uploadId);
              if (!state) {
                state = {
                  touchedAt: Date.now(),
                  pendingRequests: 0,
                  mayBeOpen: false,
                };
                uploads.set(upload.uploadId, state);
              }
            }
            trackedIngest = this.#artifactUploads.get(upload.sessionId)?.get(upload.uploadId);
            if (trackedIngest) trackedIngest.pendingRequests += 1;
          }
          const result = await connection.request(operation, input, EXTENSION_REQUEST_TIMEOUT_MS);
          if (operation === 'artifact.ingest') {
            const upload = input as ArtifactIngestInput;
            const uploads = this.#artifactUploads.get(upload.sessionId);
            if (
              upload.kind === 'abort' ||
              upload.kind === 'commit' ||
              (upload.kind === 'begin' && (result as ArtifactIngestResult).kind === 'committed')
            ) {
              const state = uploads?.get(upload.uploadId);
              if (state) {
                state.mayBeOpen = false;
              }
            } else if (upload.kind === 'begin' && trackedIngest) {
              trackedIngest.mayBeOpen = true;
              trackedIngest.touchedAt = Date.now();
              let currentUploads = this.#artifactUploads.get(upload.sessionId);
              if (!currentUploads) {
                currentUploads = new Map();
                this.#artifactUploads.set(upload.sessionId, currentUploads);
              }
              if (!currentUploads.has(upload.uploadId)) {
                currentUploads.set(upload.uploadId, trackedIngest);
              }
            } else if (upload.kind === 'chunk') {
              const state = uploads?.get(upload.uploadId);
              if (state) state.touchedAt = Date.now();
            }
          }
          return result;
        } catch (error) {
          if (operation === 'artifact.ingest') {
            const upload = input as ArtifactIngestInput;
            const uploads = this.#artifactUploads.get(upload.sessionId);
            if (upload.kind === 'begin' && trackedIngest) {
              if (
                error instanceof RuntimeHostRequestInterruptedError &&
                error.dispatch === 'dispatched'
              ) {
                trackedIngest.mayBeOpen = true;
              }
            } else if (
              upload.kind === 'commit' &&
              error instanceof RuntimeHostOperationError &&
              (error.code === 'not_found' ||
                (error.code === 'operation_conflict' &&
                  error.message === 'Attachment content digest does not match'))
            ) {
              const state = uploads?.get(upload.uploadId);
              if (state) {
                state.mayBeOpen = false;
              }
            }
          }
          if (error instanceof RequestError) throw error;
          throw requestErrorFromRuntimeHost(error, operation);
        } finally {
          if (trackedIngest) {
            trackedIngest.pendingRequests -= 1;
            const upload = input as ArtifactIngestInput;
            const uploads = this.#artifactUploads.get(upload.sessionId);
            if (!trackedIngest.mayBeOpen && trackedIngest.pendingRequests === 0) {
              if (uploads?.get(upload.uploadId) === trackedIngest) uploads.delete(upload.uploadId);
            }
          }
        }
      })(),
    );
  }

  async #pruneExpiredArtifactUploads(
    connection: AcpSessionRegistryConnection,
    sessionId: string,
    uploads: Map<string, ArtifactUploadTracking>,
  ): Promise<void> {
    const expired = [...uploads].filter(
      ([uploadId, state]) =>
        state.pendingRequests === 0 &&
        !this.#artifactCleanupTasks.has(artifactUploadKey(sessionId, uploadId)) &&
        Date.now() - state.touchedAt > ARTIFACT_UPLOAD_TTL_MS + EXTENSION_REQUEST_TIMEOUT_MS,
    );
    const cleanups = expired.map(([uploadId, state]) => {
      const key = artifactUploadKey(sessionId, uploadId);
      const cleanup = Promise.resolve()
        .then(() =>
          connection.request(
            'artifact.ingest',
            { kind: 'abort', sessionId, uploadId },
            ARTIFACT_CLEANUP_TIMEOUT_MS,
          ),
        )
        .then(
          () => {
            if (uploads.get(uploadId) === state) uploads.delete(uploadId);
          },
          () => undefined,
        )
        .finally(() => {
          if (this.#artifactCleanupTasks.get(key) === cleanup) {
            this.#artifactCleanupTasks.delete(key);
          }
        });
      this.#artifactCleanupTasks.set(key, cleanup);
      return cleanup;
    });
    await Promise.all(cleanups);
  }

  #watchArtifactConnection(connection: AcpSessionRegistryConnection): void {
    if (this.#artifactConnectionDisposer) return;
    this.#artifactConnectionDisposer = connection.subscribeConnectionAvailability(
      (availability) => {
        const identity =
          availability.kind === 'connected'
            ? JSON.stringify([availability.hostEpoch, availability.connectionId])
            : undefined;
        if (identity !== this.#artifactConnectionIdentity) {
          this.#artifactConnectionIdentity = identity;
          this.#artifactUploads.clear();
        }
      },
    );
  }

  dispose(): Promise<void> {
    this.#closing = true;
    this.#connectAbortController?.abort();
    this.#creationAbort.abort();
    for (const controller of this.#sessionLoadControllers.values()) controller.abort();
    this.#disposeTask ??= this.#dispose();
    return this.#disposeTask;
  }

  async #prompt(params: PromptRequest, context: AcpPromptContext): Promise<PromptResponse> {
    const turnId = this.#newTurnId();
    const active = new AcpAdmittedTurnObservation({
      sessionId: params.sessionId,
      turnId,
      notify: async (notification) => {
        if (!this.#closing && this.#ownedSessionIds.has(params.sessionId)) {
          await context.notify(notification);
          this.#recordLiveHistoryDelivery(params.sessionId, notification, active);
        }
      },
    });
    if (this.#historyReplays.has(params.sessionId)) void active.holdLive().catch(() => undefined);
    this.#setTurnObservation(active);
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
        attachment = await this.#ensureAttachment(params.sessionId, connection, {
          ...context,
          signal: active.projectionAbort.signal,
        });
      } catch (error) {
        if (active.cancelled) return { stopReason: await this.#cancelledStopReason(active) };
        throw error;
      }
      active.attachment = attachment;
      active.wake();
      if (active.cancelled) return { stopReason: await this.#cancelledStopReason(active) };

      try {
        startInput = {
          ...startInput,
          content: await publishAcpPromptAttachments(content, {
            sessionId: params.sessionId,
            connection,
            assertActive: () => {
              if (active.cancelled) throw new Error('ACP prompt cancelled before Turn admission');
              this.#assertOpen('turn.start');
              this.#assertOwned(params.sessionId);
            },
          }),
        };
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw requestErrorFromRuntimeHost(error, 'artifact.ingest');
      }
      if (active.cancelled) return { stopReason: await this.#cancelledStopReason(active) };

      await this.#mcps.get(params.sessionId)?.ready(active.projectionAbort.signal);
      if (active.cancelled) return { stopReason: await this.#cancelledStopReason(active) };
      this.#assertOwned(params.sessionId);
      const observation = active.start(attachment);
      // Mark the observer as handled immediately: turn.start may still be in flight
      // when the live subscription reports a failure.
      void observation.catch(() => undefined);
      active.markDispatched();
      try {
        const result = await connection.request('turn.start', startInput);
        active.settleStartRequest(result.kind === 'started' ? result.turn : undefined);
        if (result.kind === 'blocked') {
          const error = new Error('Runtime Host blocked the requested Turn');
          attachment.failTurn(turnId, error);
          throw error;
        }
      } catch (error) {
        // A lost dispatched response does not establish whether Host admitted
        // this Turn. Retain this attempt until subscription or query facts do.
        active.failStartRequest(error);
        if (!active.admission.settled) {
          this.#queryPromptAdmission(active, connection);
        }
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
      if (active.admission.failure) throw active.admission.failure;
      if (error instanceof RequestError) throw error;
      throw requestErrorFromRuntimeHost(error, 'subscription.open');
    } finally {
      context.signal.removeEventListener('abort', onAbort);
      // A terminal subscription event can precede the Stop response. Retain this
      // prompt so close/dispose cannot release its connection while Stop is in flight.
      await active.stopTask?.catch(() => undefined);
      active.dispose();
      this.#attachmentInteractions.get(active.sessionId)?.settleTurn(active.turnId);
      const observed = active.attachment?.snapshot.rootTurn;
      if (observed?.turnId === active.turnId && isRuntimeHostTerminalTurn(observed)) {
        this.#attachmentInteractions.get(active.sessionId)?.terminalTurn(active.turnId);
      }
      active.wake();
      this.#removeTurnObservation(active);
    }
  }

  async #cancelledStopReason(active: AcpAdmittedTurnObservation): Promise<'cancelled'> {
    return active.cancelledStopReason();
  }

  #cancelSession(sessionId: string): Promise<PromiseSettledResult<void>[]> {
    const active = this.#admittedTurns(sessionId);
    const cancellations = active.map((prompt) => this.#cancelPrompt(prompt));
    for (const observation of this.#turnObservations.get(sessionId)?.values() ?? []) {
      if (!(observation instanceof AcpAdmittedTurnObservation) && observation.stopTask) {
        cancellations.push(observation.stopTask);
      }
    }
    this.#attachmentOpenControllers.get(sessionId)?.abort();
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
              const observation = this.#observation(sessionId, root.turnId);
              if (observation && observation.attachment === opened) {
                observation.stopTask ??= this.#stopAttachedTurn(opened, root);
                await observation.stopTask;
              } else {
                await this.#stopAttachedTurn(opened, root);
              }
            }
          },
          () => undefined,
        ),
      );
    }
    return Promise.allSettled(cancellations);
  }

  #stopAttachedTurn(attachment: RuntimeHostSessionChannel, root: TurnSnapshot): Promise<void> {
    const current = attachment.snapshot.rootTurn;
    if (
      !current ||
      current.sessionId !== root.sessionId ||
      current.turnId !== root.turnId ||
      current.runId !== root.runId ||
      isRuntimeHostTerminalTurn(current)
    )
      return Promise.resolve();
    const observation = this.#observation(root.sessionId, root.turnId);
    if (observation && observation.runId !== undefined && observation.runId !== root.runId)
      return Promise.resolve();
    if (observation && observation.attachment === attachment) {
      observation.cancelled = true;
      observation.projectionAbort.abort();
      observation.reconciliationAbort.abort();
    }
    // Fence before sending Stop: a failed delivery cannot authorize a late answer.
    this.#attachmentInteractions.get(root.sessionId)?.cancelTurn(root.turnId);
    return (
      this.#connection
        ?.request(
          'turn.stop',
          { sessionId: root.sessionId, turnId: root.turnId, runId: root.runId },
          TURN_STOP_TIMEOUT_MS,
        )
        .then(() => undefined) ?? Promise.resolve()
    );
  }

  async #cancelPrompt(active: AcpAdmittedTurnObservation): Promise<void> {
    active.cancelled = true;
    active.wake();
    active.projectionAbort.abort();
    active.reconciliationAbort.abort();
    this.#attachmentInteractions.get(active.sessionId)?.cancelTurn(active.turnId);
    active.stopTask ??= this.#stopPromptWhenObservable(active);
    await Promise.all([
      active.mapper.flush().catch(() => undefined),
      active.stopTask.catch((error: unknown) => {
        // End only this prompt's observation. Failed delivery does not establish
        // a terminal Host Turn, and teardown still receives the original error.
        active.attachment?.failTurn(active.turnId, error);
        throw error;
      }),
    ]);
  }

  async #stopPromptWhenObservable(active: AcpAdmittedTurnObservation): Promise<void> {
    if (!active.admission.dispatchStarted) return;
    while (!active.finished) {
      const observed = active.attachment?.snapshot.rootTurn;
      // Subscription teardown can precede the start response. Keep the admitted
      // identity until exact Stop completes, even when observation has ended.
      const root = observed?.turnId === active.turnId ? observed : active.admission.startedTurn;
      if (root) {
        if (isRuntimeHostTerminalTurn(root)) return;
        const connection = this.#connection;
        if (!connection) return;
        try {
          await connection.request(
            'turn.stop',
            { sessionId: root.sessionId, turnId: root.turnId, runId: root.runId },
            TURN_STOP_TIMEOUT_MS,
          );
        } catch (error) {
          console.error('[acp] Host Stop delivery failed:', error);
          throw error;
        }
        return;
      }
      if (active.admission.settled && active.admission.startRequestSettled) return;
      if (active.admission.failure) {
        console.error('[acp] Host Turn admission remains unknown:', active.admission.failure);
        throw active.admission.failure;
      }
      await active.waitForChange();
    }
  }

  #queryPromptAdmission(
    active: AcpAdmittedTurnObservation,
    connection: AcpSessionRegistryConnection,
  ): void {
    // Recovery and the lost start response can both request this read. Keep one
    // bounded retry task; neither a healthy subscription nor a query failure
    // other than not_found establishes whether a dispatched start was admitted.
    active.admission.query ??= this.#readPromptAdmission(active, connection);
  }

  async #readPromptAdmission(
    active: AcpAdmittedTurnObservation,
    connection: AcpSessionRegistryConnection,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < ADMISSION_QUERY_MAX_ATTEMPTS; attempt += 1) {
      if (active.finished || active.admission.settled || (this.#closing && attempt > 0)) return;
      const observed = active.attachment?.snapshot.rootTurn;
      if (observed?.turnId === active.turnId) {
        active.observeStartedTurn(observed);
        return;
      }
      try {
        const turn = await connection.request(
          'turn.query',
          { sessionId: active.sessionId, turnId: active.turnId },
          ADMISSION_QUERY_TIMEOUT_MS,
        );
        if (!active.finished && !active.admission.settled) {
          active.observeStartedTurn(turn);
        }
        return;
      } catch (error) {
        if (error instanceof RuntimeHostOperationError && error.code === 'not_found') {
          const observed = active.attachment?.snapshot.rootTurn;
          active.settleAbsentTurn(observed?.turnId === active.turnId ? observed : undefined);
          return;
        }
        lastError = error;
      }
      if (active.finished || active.admission.settled || this.#closing) return;
      if (attempt + 1 < ADMISSION_QUERY_MAX_ATTEMPTS) {
        await active.waitForChange(ADMISSION_QUERY_RETRY_MS * 2 ** attempt);
      }
    }
    if (active.attachment?.snapshot.rootTurn?.turnId === active.turnId) {
      active.wake();
      return;
    }
    active.failAdmission(
      RequestError.internalError(
        {
          source: 'runtime_host',
          operation: 'turn.query',
          code: 'outcome_unknown',
          reason: 'admission_query_failed',
          attempts: ADMISSION_QUERY_MAX_ATTEMPTS,
          cause: runtimeHostErrorData(lastError, 'turn.query'),
        },
        'Runtime Host Turn admission could not be established; Stop could not be confirmed',
      ),
    );
  }

  async #ensureAttachment(
    sessionId: string,
    connection: AcpSessionRegistryConnection,
    context: AcpPromptContext,
  ): Promise<RuntimeHostSessionChannel> {
    context.signal.throwIfAborted();
    let waiters = this.#attachmentWaiters.get(sessionId);
    if (!waiters) {
      waiters = new Set();
      this.#attachmentWaiters.set(sessionId, waiters);
    }
    const waiter = {};
    waiters.add(waiter);
    try {
      return await abortable(
        () => this.#openAttachment(sessionId, connection, context),
        context.signal,
      );
    } finally {
      waiters.delete(waiter);
      if (waiters.size === 0 && this.#attachmentWaiters.get(sessionId) === waiters) {
        this.#attachmentWaiters.delete(sessionId);
        if (context.signal.aborted && !this.#hasAttachmentConsumers(sessionId)) {
          this.#attachmentOpenControllers.get(sessionId)?.abort();
        }
      }
    }
  }

  #hasAttachmentConsumers(sessionId: string): boolean {
    return (
      (this.#attachmentWaiters.get(sessionId)?.size ?? 0) > 0 ||
      this.#admittedTurns(sessionId).some((active) => !active.cancelled && !active.finished)
    );
  }

  async #openAttachment(
    sessionId: string,
    connection: AcpSessionRegistryConnection,
    context: AcpPromptContext,
  ): Promise<RuntimeHostSessionChannel> {
    const existing = this.#attachments.get(sessionId);
    if (existing) return existing;
    const openingController = new AbortController();
    this.#attachmentOpenControllers.set(sessionId, openingController);
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
      client: context.interactions ?? UNAVAILABLE_INTERACTION_CLIENT,
      onPending: async (pending) => {
        const observation = this.#observation(sessionId, pending.turnId);
        if (observation && !observation.cancelled) {
          await observation.pendingInteraction(pending);
        }
      },
      onAnswered: (answered, pending) => attachment?.publishInteractionAnswer(answered, pending),
      onResolved: async (resolved, pending) => {
        const observation = this.#observation(sessionId, pending.turnId);
        if (observation && !observation.cancelled && !observation.finished) {
          await observation.resolvedInteraction(resolved, pending);
        }
      },
      onFailure: (pending, error) => {
        const observation = this.#observation(sessionId, pending.turnId);
        if (observation?.attachment) {
          if (!(observation instanceof AcpAdmittedTurnObservation)) {
            console.error('[acp] Attached interaction presentation failed:', error);
            return;
          }
          observation.projectionFailure ??= error;
          observation.attachment.failTurn(observation.turnId, error);
        } else if (!attachment) failAttachment(error);
      },
      onCancelled: (pending) => {
        let localPrompt = false;
        for (const active of this.#admittedTurns(sessionId)) {
          if (active.turnId === pending.turnId) {
            localPrompt = true;
            void this.#cancelPrompt(active).catch(() => undefined);
          }
        }
        if (!localPrompt && this.#observation(sessionId, pending.turnId)) {
          void this.#cancelSession(sessionId).catch(() => undefined);
        }
      },
    });
    this.#attachmentInteractions.set(sessionId, interactions);
    const domainObservation = new AcpSessionDomainObservation({
      sessionId,
      queryPlan: () => connection.request('plan.query', { kind: 'list_start', sessionId }),
      goalNotify: () => this.#externalObservationContexts.get(sessionId)?.notifyGoalStatus,
      planNotify: () => this.#externalObservationContexts.get(sessionId)?.notifyPlanChanged,
    });
    this.#domainObservations.set(sessionId, domainObservation);
    task = RuntimeHostSessionChannel.open({
      connection,
      signal: openingController.signal,
      openInitialSessionSubscription: connection.openSessionSubscriptionOnce.bind(connection),
      sessionId,
      now: Date.now,
      onTurnStarted: (turn) => {
        if (attachment)
          void this.#adoptTurn(
            sessionId,
            turn.turnId,
            attachment,
            false,
            turn.runId,
            attachment.terminalTurn(turn.turnId),
          ).catch((error: unknown) => {
            console.error('[acp] Attached Turn observation failed:', error);
          });
      },
      onRuntimeResourceChanged: () => undefined,
      onSessionDomainChanged: (frame) => {
        if (
          frame.domain === 'plan' &&
          this.#externalObservationContexts.get(sessionId)?.notifyPlanChanged
        )
          domainObservation.planChanged();
      },
      onCanonicalReplacement: (snapshot) => {
        if (attachment && this.#discardedAttachments.has(attachment)) return;
        if (
          this.#externalObservationContexts.get(sessionId)?.notifyPlanChanged ||
          this.#externalObservationContexts.get(sessionId)?.notifyGoalStatus
        ) {
          domainObservation.canonicalReplacement(snapshot.goal);
        }
      },
      onSnapshotChanged: (snapshot) => {
        if (attachment && this.#discardedAttachments.has(attachment)) return;
        this.#wakeSession(sessionId);
        if (snapshot.rootTurn && isRuntimeHostTerminalTurn(snapshot.rootTurn)) {
          interactions.terminalTurn(snapshot.rootTurn.turnId);
        }
        const root = snapshot.rootTurn;
        const observation = root && this.#observation(sessionId, root.turnId);
        const prompt = observation instanceof AcpAdmittedTurnObservation ? observation : undefined;
        const observedRunId =
          observation?.runId ??
          prompt?.admission.startedTurn?.runId ??
          observation?.terminalTurn?.runId;
        if (root && observation && (observedRunId === undefined || observedRunId === root.runId)) {
          if (isRuntimeHostTerminalTurn(root)) observation.terminalTurn = root;
          if (prompt) {
            prompt.observeStartedTurn(root);
          }
        }
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
        if (attachment && this.#discardedAttachments.has(attachment)) return;
        const observation = this.#observation(sessionId, turnId);
        if (observation && !observation.cancelled) {
          void observation.replaceTranscript(messages).catch((error: unknown) => {
            observation.attachment?.failTurn(turnId, error);
          });
        }
      },
      onInteractionPending: (pending) => {
        if (attachment && this.#discardedAttachments.has(attachment)) return;
        if (
          !interactions.fencesTurn(pending.turnId) &&
          !this.#observation(sessionId, pending.turnId)
        ) {
          // An idle attachment can observe another client's Turn; it does not
          // transfer that Turn's interaction authority to this ACP client.
          return;
        }
        void interactions.pending(pending);
      },
      onInteractionResolved: (pending) => {
        if (attachment && this.#discardedAttachments.has(attachment)) return;
        if (
          !interactions.fencesTurn(pending.turnId) &&
          !this.#observation(sessionId, pending.turnId)
        )
          return;
        void interactions.resolved(pending);
      },
      onTranscriptSettlement: (turnId) => {
        if (attachment && this.#discardedAttachments.has(attachment)) return;
        void this.#observation(sessionId, turnId)
          ?.reconcile()
          .catch(() => undefined);
      },
      onGoalChanged: (goal) => domainObservation.goalChanged(goal),
      onFailed: failAttachment,
      onRecovered: () => {
        for (const active of this.#admittedTurns(sessionId)) {
          if (
            active.attachment !== attachment ||
            !active.admission.startRequestSettled ||
            active.admission.settled
          ) {
            continue;
          }
          // Recovery may hydrate a snapshot taken before start admission.
          // An absent root needs a fresh query; a matching root can be stopped
          // directly by the existing cancellation task.
          if (attachment?.snapshot.rootTurn?.turnId !== active.turnId) {
            this.#queryPromptAdmission(active, connection);
          }
          active.wake();
        }
      },
    })
      .then(async ({ channel, attachedTurnId }) => {
        attachment = channel;
        if (earlyFailure) {
          this.#retireFailedAttachment(sessionId, task, channel, earlyFailure);
          throw earlyFailure;
        }
        if (this.#closing || !this.#ownedSessionIds.has(sessionId)) {
          await channel.close();
          throw this.#closing ? registryClosedError('subscription.open') : unknownSessionError();
        }
        if (attachedTurnId) {
          const root = channel.snapshot.rootTurn;
          await this.#adoptTurn(
            sessionId,
            attachedTurnId,
            channel,
            false,
            root?.turnId === attachedTurnId
              ? root.runId
              : channel.terminalTurn(attachedTurnId)?.runId,
            channel.terminalTurn(attachedTurnId),
          );
        }
        channel.activate(
          attachedTurnId && this.#observation(sessionId, attachedTurnId)
            ? attachedTurnId
            : undefined,
        );
        if (
          this.#externalObservationContexts.get(sessionId)?.notifyGoalStatus ||
          this.#externalObservationContexts.get(sessionId)?.notifyPlanChanged
        ) {
          domainObservation.initialize(channel.snapshot.goal);
        }
        return channel;
      })
      .catch((error: unknown) => {
        domainObservation.dispose();
        if (this.#domainObservations.get(sessionId) === domainObservation)
          this.#domainObservations.delete(sessionId);
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
      })
      .finally(() => {
        if (this.#attachmentOpenControllers.get(sessionId) === openingController) {
          this.#attachmentOpenControllers.delete(sessionId);
        }
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
    this.#detachAttachment(sessionId, task);
    for (const active of this.#admittedTurns(sessionId)) {
      if (active.attachment !== attachment) continue;
      // Losing observation cannot settle a dispatched start. Its pending
      // response or bounded admission query still owns the exact Stop identity.
      attachment.failTurn(active.turnId, error);
      active.wake();
    }
    for (const observation of this.#turnObservations.get(sessionId)?.values() ?? []) {
      if (
        observation.attachment !== attachment ||
        observation instanceof AcpAdmittedTurnObservation
      )
        continue;
      observation.attachment.failTurn(observation.turnId, error);
    }
    void attachment.close().catch(() => undefined);
  }

  #detachAttachment(
    sessionId: string,
    expected = this.#attachments.get(sessionId),
  ): Promise<RuntimeHostSessionChannel> | undefined {
    if (!expected || this.#attachments.get(sessionId) !== expected) return;
    this.#attachmentOpenControllers.get(sessionId)?.abort();
    this.#attachmentInteractions.get(sessionId)?.close();
    this.#attachmentInteractions.delete(sessionId);
    this.#domainObservations.get(sessionId)?.dispose();
    this.#domainObservations.delete(sessionId);
    this.#attachmentConfigurations.delete(sessionId);
    this.#attachments.delete(sessionId);
    return expected;
  }

  #detachMcp(sessionId: string, expected = this.#mcps.get(sessionId)): AcpSessionMcp | undefined {
    if (!expected || this.#mcps.get(sessionId) !== expected) return;
    this.#mcps.delete(sessionId);
    return expected;
  }

  async #closeSession(sessionId: string, delivery?: Promise<void>): Promise<CloseSessionResponse> {
    const cancellation = await this.#cancelSession(sessionId);
    this.#externalObservationContexts.delete(sessionId);
    this.#externalContextLeases.delete(sessionId);
    for (const observation of this.#turnObservations.get(sessionId)?.values() ?? []) {
      if (!(observation instanceof AcpAdmittedTurnObservation)) {
        observation.dispose();
        this.#removeTurnObservation(observation);
      }
    }
    const attachmentTask = this.#detachAttachment(sessionId);
    let closeError: unknown;
    const artifactOperations = this.#artifactOperations.get(sessionId);
    if (artifactOperations) await Promise.allSettled([...artifactOperations]);
    const uploads = this.#artifactUploads.get(sessionId);
    this.#artifactUploads.delete(sessionId);
    if (uploads && this.#connection) {
      const aborts = await Promise.allSettled(
        [...uploads.keys()].map((uploadId) =>
          this.#connection!.request(
            'artifact.ingest',
            { kind: 'abort', sessionId, uploadId },
            ARTIFACT_CLEANUP_TIMEOUT_MS,
          ),
        ),
      );
      const failedAbort = aborts.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failedAbort) {
        closeError = requestErrorFromRuntimeHost(failedAbort.reason, 'artifact.ingest');
      }
    }
    if (attachmentTask) {
      try {
        // A rejected open has no retained resource; close still releases ownership.
        const attachment = await attachmentTask.catch(() => undefined);
        await attachment?.close();
      } catch (error) {
        closeError ??= error;
      }
    }
    const mcp = this.#detachMcp(sessionId);
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

  async #adoptTurn(
    sessionId: string,
    turnId: string,
    attachment: RuntimeHostSessionChannel,
    trackAdmission = false,
    expectedRunId?: string,
    initialTerminalTurn?: RuntimeHostTerminalTurn,
  ): Promise<AcpTurnObservation | undefined> {
    const context = this.#externalObservationContexts.get(sessionId);
    if (
      !context ||
      this.#closing ||
      this.#discardedAttachments.has(attachment) ||
      !this.#ownedSessionIds.has(sessionId)
    )
      return;
    const existing = this.#observation(sessionId, turnId);
    if (existing) {
      this.#replayPendingInteractions(sessionId, turnId, attachment, existing);
      return existing;
    }
    const runId =
      expectedRunId ??
      (attachment.snapshot.rootTurn?.turnId === turnId
        ? attachment.snapshot.rootTurn.runId
        : undefined);
    const Observation = trackAdmission ? AcpAdmittedTurnObservation : AcpTurnObservation;
    const observation = new Observation({
      sessionId,
      turnId,
      ...(runId === undefined ? {} : { runId }),
      notify: async (notification) => {
        const current = this.#externalObservationContexts.get(sessionId);
        if (!this.#closing && this.#ownedSessionIds.has(sessionId) && current) {
          await current.notify(notification);
          this.#recordLiveHistoryDelivery(sessionId, notification, observation);
        }
      },
    });
    if (initialTerminalTurn?.runId === runId) observation.terminalTurn = initialTerminalTurn;
    if (this.#historyReplays.has(sessionId)) void observation.holdLive().catch(() => undefined);
    const admission = observation instanceof AcpAdmittedTurnObservation ? observation : undefined;
    if (admission) this.#setTurnObservation(admission);
    else this.#setTurnObservation(observation);
    try {
      await observation.seed(attachment.messages);
      if (
        this.#observation(sessionId, turnId) !== observation ||
        this.#closing ||
        this.#discardedAttachments.has(attachment)
      ) {
        observation.dispose();
        if (admission) this.#removeTurnObservation(admission);
        else this.#removeTurnObservation(observation);
        return;
      }
      const task = observation.start(attachment);
      this.#replayPendingInteractions(sessionId, turnId, attachment, observation);
      const interactions = this.#attachmentInteractions.get(sessionId);
      void task
        .then(
          async () => {
            if (
              observation.finished ||
              this.#observation(sessionId, turnId) !== observation ||
              this.#discardedAttachments.has(attachment)
            )
              return;
            const root = observation.terminalTurn;
            const outcome = root ?? observation.terminalOutcome;
            const runId = root?.runId ?? observation.runId;
            if (outcome && runId) {
              await this.#externalObservationContexts.get(sessionId)?.notifyTurnStatus?.({
                sessionId,
                turnId,
                runId,
                status: outcome.status,
                ...(outcome.status === 'failed'
                  ? { failureClass: outcome.failureClass ?? 'runtime_error' }
                  : {}),
              });
            }
          },
          async (error: unknown) => {
            if (
              !this.#closing &&
              !observation.finished &&
              this.#observation(sessionId, turnId) === observation &&
              !this.#discardedAttachments.has(attachment)
            ) {
              console.error('[acp] Attached Turn observation failed:', error);
              const root = attachment.snapshot.rootTurn;
              if (
                root?.turnId === turnId &&
                (observation.runId === undefined || root.runId === observation.runId) &&
                !isRuntimeHostTerminalTurn(root)
              ) {
                observation.stopTask ??= this.#stopAttachedTurn(attachment, root);
                void observation.stopTask.catch((stopError: unknown) => {
                  console.error('[acp] Host Stop delivery failed:', stopError);
                });
              }
              await this.#externalObservationContexts.get(sessionId)?.notifyTurnStatus?.({
                sessionId,
                turnId,
                runId: root?.turnId === turnId ? root.runId : '',
                status: 'observation_failed',
              });
            }
          },
        )
        .catch((error: unknown) => {
          console.error('[acp] Attached Turn status delivery failed:', error);
        })
        .finally(async () => {
          if (admission) {
            while (
              admission.admission.dispatchStarted &&
              !admission.admission.startRequestSettled &&
              !this.#closing
            ) {
              await admission.waitForChange();
            }
          }
          await observation.stopTask?.catch(() => undefined);
          if (admission) this.#removeTurnObservation(admission);
          interactions?.settleTurn(turnId);
          observation.dispose();
          this.#removeTurnObservation(observation);
        });
      return observation;
    } catch (error) {
      observation.dispose();
      if (admission) this.#removeTurnObservation(admission);
      else this.#removeTurnObservation(observation);
      throw error;
    }
  }

  #replayPendingInteractions(
    sessionId: string,
    turnId: string,
    attachment: RuntimeHostSessionChannel,
    observation: AcpTurnObservation,
  ): void {
    if (observation.finished || this.#discardedAttachments.has(attachment)) return;
    const interactions = this.#attachmentInteractions.get(sessionId);
    for (const pending of attachment.snapshot.interactions.pending) {
      if (pending.turnId === turnId) void interactions?.pending(pending);
    }
  }

  async #resumeTurn(
    params: { sessionId: string; sourceRunId?: string; expectedRuntimeEventHighWater?: number },
    context: AcpLoadContext,
  ) {
    context.signal.throwIfAborted();
    const connection = await this.#getConnection('turn.resume.query');
    let plan;
    try {
      plan = await connection.request('turn.resume.query', params);
    } catch (error) {
      throw requestErrorFromRuntimeHost(error, 'turn.resume.query');
    }
    if (plan.disposition === 'parked') return { kind: 'parked' as const, plan };
    const restoreContext = this.#installExternalContext(params.sessionId, context);
    const restoreClient = this.#attachmentInteractions
      .get(params.sessionId)
      ?.setClient(context.interactions ?? UNAVAILABLE_INTERACTION_CLIENT);
    let observation: AcpAdmittedTurnObservation | undefined;
    let attachment: RuntimeHostSessionChannel | undefined;
    const turnId = this.#newTurnId();
    let dispatched = false;
    const onAbort = () => {
      if (observation) void this.#cancelPrompt(observation).catch(() => undefined);
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const prepared = await this.#prepareExternalObservation(
        params.sessionId,
        context,
        connection,
        'turn.resume.start',
        turnId,
      );
      attachment = prepared.attachment;
      observation = prepared.observation;
      if (!observation) throw registryClosedError('turn.resume.start');
      if (context.signal.aborted) onAbort();
      if (observation.cancelled)
        throw RequestError.internalError(
          { source: 'adapter', operation: 'turn.resume.start', code: 'cancelled' },
          'Turn resume was cancelled before admission',
        );
      dispatched = true;
      observation.markDispatched();
      const result = await connection.request('turn.resume.start', {
        sessionId: params.sessionId,
        turnId,
        sourceRunId: plan.sourceRunId,
        sourceRuntimeEventHighWater: plan.sourceRuntimeEventHighWater,
      });
      observation.settleStartRequest(result.kind === 'started' ? result.turn : undefined);
      if (result.kind === 'parked') {
        observation.dispose();
        this.#removeTurnObservation(observation);
        attachment.failTurn(turnId, new Error(`Turn resume parked: ${result.plan.reason}`));
        restoreContext.commit();
        restoreClient?.commit();
        return { kind: 'parked' as const, plan: result.plan };
      }
      await observation.stopTask?.catch(() => undefined);
      restoreContext.commit();
      restoreClient?.commit();
      return {
        kind: 'started' as const,
        turn: result.turn,
        sourceRunId: plan.sourceRunId,
        sourceRuntimeEventHighWater: plan.sourceRuntimeEventHighWater,
      };
    } catch (error) {
      let failure = error;
      if (observation) {
        observation.failStartRequest(error);
      }
      if (
        dispatched &&
        error instanceof RuntimeHostRequestInterruptedError &&
        error.dispatch === 'dispatched' &&
        observation
      ) {
        this.#queryPromptAdmission(observation, connection);
        await observation.admission.query;
        if (observation.admission.startedTurn) {
          restoreContext.commit();
          restoreClient?.commit();
          return {
            kind: 'started' as const,
            turn: observation.admission.startedTurn,
            sourceRunId: plan.sourceRunId,
            sourceRuntimeEventHighWater: plan.sourceRuntimeEventHighWater,
          };
        }
        const admissionError = RequestError.internalError(
          {
            source: 'runtime_host',
            operation: 'turn.resume.start',
            code: 'outcome_unknown',
            sessionId: params.sessionId,
            turnId,
            sourceRunId: plan.sourceRunId,
          },
          'Runtime Host Turn resume admission could not be established',
        );
        if (!observation.admission.rejected) {
          // The dispatched Turn may still be running, so its context and
          // interaction client remain the current attachment authority.
          restoreContext.commit();
          restoreClient?.commit();
          throw admissionError;
        }
        failure = admissionError;
      }
      if (observation) {
        observation.dispose();
        this.#removeTurnObservation(observation);
        attachment?.failTurn(turnId, failure);
      }
      restoreContext.rollback();
      restoreClient?.rollback();
      if (failure instanceof RequestError) throw failure;
      throw requestErrorFromRuntimeHost(failure, 'turn.resume.start', { turnId });
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }
  }

  async #copySession(
    operation: 'session.branch.create' | 'session.revision.create',
    params: SessionConversationCopyInput,
  ): Promise<SessionConversationCopyResult> {
    this.#assertOpen(operation);
    this.#assertOwned(params.sourceSessionId);
    if (this.#ownedSessionIds.has(params.targetSessionId)) {
      throw RequestError.invalidParams(
        { field: 'targetSessionId', reason: 'already_owned' },
        'Target Session is already owned by this ACP connection',
      );
    }
    const connection = await this.#getConnection(operation);
    this.#assertOwned(params.sourceSessionId);
    let result: SessionConversationCopyResult;
    try {
      result = await connection.request(operation, params);
    } catch (error) {
      if (
        error instanceof RuntimeHostRequestInterruptedError &&
        error.dispatch === 'dispatched' &&
        !this.#closing
      ) {
        // The target ID alone is not proof of ownership: a lost response may
        // have been an operation_conflict with another caller's target. The
        // Host's exact copy request is idempotent by target and fingerprint.
        try {
          result = await connection.request(operation, params, COPY_RECONCILIATION_TIMEOUT_MS);
        } catch (reconciliationError) {
          throw requestErrorFromRuntimeHost(reconciliationError, operation, {
            targetSessionId: params.targetSessionId,
          });
        }
      } else {
        throw requestErrorFromRuntimeHost(error, operation, {
          targetSessionId: params.targetSessionId,
        });
      }
    }
    if (result.kind === 'committed' && !this.#closing) {
      this.#ownedSessionIds.add(params.targetSessionId);
    }
    return result;
  }

  async #abandonRevision(
    params: SessionRevisionAbandonInput,
  ): Promise<SessionRevisionAbandonResult> {
    const connection = await this.#getConnection('session.revision.abandon');
    this.#assertOwned(params.targetSessionId);
    let result: SessionRevisionAbandonResult;
    try {
      result = await connection.request('session.revision.abandon', params);
    } catch (error) {
      throw requestErrorFromRuntimeHost(error, 'session.revision.abandon');
    }
    if (result.kind === 'abandoned') {
      this.#sessionCloseGenerations.set(
        params.targetSessionId,
        (this.#sessionCloseGenerations.get(params.targetSessionId) ?? 0) + 1,
      );
      this.#sessionLoadControllers.get(params.targetSessionId)?.abort();
      this.#ownedSessionIds.delete(params.targetSessionId);
      this.#historyReplayDelivery.delete(params.targetSessionId);
      this.#externalObservationContexts.delete(params.targetSessionId);
      this.#externalContextLeases.delete(params.targetSessionId);
      for (const observation of this.#turnObservations.get(params.targetSessionId)?.values() ??
        []) {
        observation.cancelled = true;
        observation.dispose();
        if (observation instanceof AcpAdmittedTurnObservation) observation.wake();
        else this.#removeTurnObservation(observation);
      }
      const attachment = this.#detachAttachment(params.targetSessionId);
      const mcp = this.#detachMcp(params.targetSessionId);
      await Promise.allSettled([
        attachment?.then(
          (channel) => channel.close(),
          () => undefined,
        ),
        mcp?.close(),
      ]);
    }
    return result;
  }

  #admittedTurns(sessionId: string): AcpAdmittedTurnObservation[] {
    return [...(this.#turnObservations.get(sessionId)?.values() ?? [])].filter(
      (observation): observation is AcpAdmittedTurnObservation =>
        observation instanceof AcpAdmittedTurnObservation,
    );
  }

  #installExternalContext(sessionId: string, context: AcpLoadContext): AcpContextReplacement {
    const lease: AcpExternalContextLease = {
      context,
      previous: this.#externalContextLeases.get(sessionId),
      valid: true,
    };
    this.#externalContextLeases.set(sessionId, lease);
    this.#externalObservationContexts.set(sessionId, context);
    return {
      rollback: () => {
        lease.valid = false;
        if (this.#externalContextLeases.get(sessionId) !== lease) return;
        let previous = lease.previous;
        while (previous && !previous.valid) previous = previous.previous;
        if (previous) {
          this.#externalContextLeases.set(sessionId, previous);
          this.#externalObservationContexts.set(sessionId, previous.context);
        } else {
          this.#externalContextLeases.delete(sessionId);
          this.#externalObservationContexts.delete(sessionId);
        }
      },
      commit: () => {
        lease.previous = undefined;
      },
    };
  }

  #setTurnObservation(observation: AcpTurnObservation): void {
    let observations = this.#turnObservations.get(observation.sessionId);
    if (!observations) {
      observations = new Map();
      this.#turnObservations.set(observation.sessionId, observations);
    }
    observations.set(observation.turnId, observation);
  }

  #removeTurnObservation(observation: AcpTurnObservation): void {
    const observations = this.#turnObservations.get(observation.sessionId);
    if (observations?.get(observation.turnId) !== observation) return;
    observations.delete(observation.turnId);
    if (observations.size === 0) this.#turnObservations.delete(observation.sessionId);
    if (
      observation instanceof AcpAdmittedTurnObservation &&
      !this.#hasAttachmentConsumers(observation.sessionId)
    ) {
      this.#attachmentOpenControllers.get(observation.sessionId)?.abort();
    }
  }

  #observation(sessionId: string, turnId: string): AcpTurnObservation | undefined {
    return this.#turnObservations.get(sessionId)?.get(turnId);
  }

  #wakeSession(sessionId: string): void {
    for (const active of this.#admittedTurns(sessionId)) active.wake();
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

  async #load(
    params: LoadSessionRequest | ResumeSessionRequest,
    context: AcpLoadContext,
    mcpConfig: McpConfigFile,
    replayHistory: boolean,
    requestedGeneration: number,
  ): Promise<LoadSessionResponse> {
    if ((this.#sessionCloseGenerations.get(params.sessionId) ?? 0) !== requestedGeneration) {
      throw unknownSessionError();
    }
    const existingReplayDelivery = this.#historyReplayDelivery.get(params.sessionId);
    const replayDelivery = replayHistory
      ? (existingReplayDelivery ?? {
          textByMessage: new Map<string, string>(),
          otherUpdates: new Set<string>(),
        })
      : undefined;
    if (replayDelivery && !existingReplayDelivery) {
      // An attached Turn may have streamed before load started. Retain its
      // absolute message prefix so later live chunks are not mistaken for one.
      for (const observation of this.#turnObservations.get(params.sessionId)?.values() ?? []) {
        for (const [key, prefix] of observation.deliveredTextByMessage) {
          replayDelivery.textByMessage.set(key, prefix);
        }
      }
    }
    if (replayDelivery) this.#historyReplayDelivery.set(params.sessionId, replayDelivery);
    const loadController = new AbortController();
    this.#sessionLoadControllers.set(params.sessionId, loadController);
    const lifetime = AbortSignal.any([
      context.signal,
      loadController.signal,
      this.#creationAbort.signal,
    ]);
    const generation = this.#sessionCloseGenerations.get(params.sessionId) ?? 0;
    const alreadyOwned = this.#ownedSessionIds.has(params.sessionId);
    const heldObservations = new Set<AcpTurnObservation>();
    let restoreContext: AcpContextReplacement | undefined;
    let restoreClient: ReturnType<AcpSessionInteractions['setClient']> | undefined;
    const previousMcp = this.#mcps.get(params.sessionId);
    const previousMcpConfig = previousMcp?.config;
    let previousMcpReconfigureAttempted = false;
    let installedMcp: AcpSessionMcp | undefined;
    let newAttachment: Promise<RuntimeHostSessionChannel> | undefined;
    try {
      lifetime.throwIfAborted();
      const connection = await this.#getConnection('session.catalog.query');
      let session: SessionCatalogProjection | null;
      try {
        session = await getRuntimeHostSession(connection, params.sessionId);
      } catch (error) {
        throw requestErrorFromSessionUpdate(error, 'session.catalog.query');
      }
      if (!session) {
        throw RequestError.invalidParams(
          { source: 'runtime_host', operation: 'session.catalog.query', code: 'not_found' },
          'Runtime Host Session was not found',
        );
      }
      if (session.isArchived) {
        throw RequestError.invalidParams(
          { source: 'runtime_host', operation: 'session.catalog.query', code: 'archived' },
          'Archived Runtime Host Sessions cannot be loaded',
        );
      }
      const cwd = await normalizeCwd(params.cwd);
      if (cwd !== session.workspace.hostCwd) {
        throw RequestError.invalidParams(
          { field: 'cwd', reason: 'session_cwd_mismatch' },
          'cwd does not match the existing Session workspace',
        );
      }
      lifetime.throwIfAborted();
      const configOptions = await this.#projectConfigOptions(connection, session);
      if ((this.#sessionCloseGenerations.get(params.sessionId) ?? 0) !== generation) {
        throw unknownSessionError();
      }
      if (previousMcp) {
        previousMcpReconfigureAttempted = true;
        await previousMcp.reconfigure(mcpConfig, lifetime, async () => {
          const latest = await getRuntimeHostSession(connection, params.sessionId);
          if (!latest) throw unknownSessionError();
          if (
            latest.status === 'running' ||
            latest.status === 'waiting_for_user' ||
            (latest.liveRunState?.runningTurnIds.length ?? 0) > 0 ||
            this.#admittedTurns(params.sessionId).length > 0
          ) {
            throw RequestError.internalError(
              { source: 'adapter', operation: 'mcp.prepare', code: 'session_busy' },
              'Cannot replace Session MCP configuration during an active Turn',
            );
          }
        });
      } else {
        installedMcp = new AcpSessionMcp(params.sessionId, mcpConfig, connection);
        this.#mcps.set(params.sessionId, installedMcp);
        await installedMcp.prepare(lifetime);
      }
      if ((this.#sessionCloseGenerations.get(params.sessionId) ?? 0) !== generation) {
        throw unknownSessionError();
      }
      this.#ownedSessionIds.add(params.sessionId);
      if (replayHistory) {
        this.#historyReplays.add(params.sessionId);
        for (const observation of this.#turnObservations.get(params.sessionId)?.values() ?? []) {
          heldObservations.add(observation);
        }
        await Promise.all([...heldObservations].map((observation) => observation.holdLive()));
      }
      restoreContext = this.#installExternalContext(params.sessionId, context);
      restoreClient = this.#attachmentInteractions
        .get(params.sessionId)
        ?.setClient(context.interactions ?? UNAVAILABLE_INTERACTION_CLIENT);
      const creatingAttachment = !this.#attachments.has(params.sessionId);
      const attachmentPromise = this.#ensureAttachment(params.sessionId, connection, {
        ...context,
        signal: lifetime,
      });
      if (creatingAttachment) newAttachment = this.#attachments.get(params.sessionId);
      const attachment = await attachmentPromise;
      lifetime.throwIfAborted();
      this.#assertOpen('subscription.open');
      this.#assertOwned(params.sessionId);
      if (context.notifyGoalStatus || context.notifyPlanChanged) {
        this.#domainObservations.get(params.sessionId)?.initialize(attachment.snapshot.goal);
      }
      if ((this.#sessionCloseGenerations.get(params.sessionId) ?? 0) !== generation) {
        throw unknownSessionError();
      }
      // A retained attachment may have observed this Turn before load/resume
      // installed its presentation context. Attach its existing event consumer
      // now; opening a second channel would lose the queue and interaction state.
      const root = attachment.snapshot.rootTurn;
      if (
        root &&
        !isRuntimeHostTerminalTurn(root) &&
        !attachment.hasQueuedStartedTurn(root.turnId)
      ) {
        await this.#adoptTurn(params.sessionId, root.turnId, attachment, false, root.runId);
        lifetime.throwIfAborted();
        this.#assertOpen('subscription.open');
        this.#assertOwned(params.sessionId);
        if ((this.#sessionCloseGenerations.get(params.sessionId) ?? 0) !== generation) {
          throw unknownSessionError();
        }
      }
      if (replayHistory) {
        const mappers = new Map<string, AcpSessionEventMapper>();
        await attachment.replayTranscript(async (messages) => {
          const active = this.#turnObservations.get(params.sessionId);
          for (const observation of active?.values() ?? []) {
            if (!heldObservations.has(observation)) {
              heldObservations.add(observation);
              await observation.holdLive();
            }
            await observation.seed(messages);
          }
          for (const message of messages) {
            lifetime.throwIfAborted();
            if (!message.turnId) continue;
            let mapper = mappers.get(message.turnId);
            if (!mapper) {
              mapper = new AcpSessionEventMapper({
                sessionId: params.sessionId,
                notify: (notification) =>
                  this.#deliverHistoryNotification(notification, context.notify, replayDelivery!),
                signal: lifetime,
              });
              mappers.set(message.turnId, mapper);
            }
            await mapper.acceptHistoricalMessage(message);
            if (message.type === 'turn_state' && message.status !== 'running') {
              await mapper.finishTools(
                message.turnId,
                message.status === 'aborted' ? 'cancelled' : message.status,
              );
              await mapper.flush();
              mappers.delete(message.turnId);
            }
          }
        }, lifetime);
        await Promise.all([...mappers.values()].map((mapper) => mapper.flush()));
      }
      restoreContext.commit();
      restoreClient?.commit();
      if (replayHistory) this.#historyReplayDelivery.delete(params.sessionId);
      return { configOptions };
    } catch (error) {
      const sharedAttachment =
        newAttachment &&
        this.#attachments.get(params.sessionId) === newAttachment &&
        this.#hasAttachmentConsumers(params.sessionId);
      if (sharedAttachment) {
        // A concurrent prompt has adopted this prepared Session. Its attachment,
        // ownership and MCP provider must outlive this cancelled/failed load.
        restoreContext?.rollback();
        restoreClient?.rollback();
        if (error instanceof RequestError) throw error;
        throw requestErrorFromRuntimeHost(error, 'subscription.open');
      }
      if (newAttachment && this.#attachments.get(params.sessionId) === newAttachment) {
        const channel = await newAttachment.catch(() => undefined);
        if (channel) {
          this.#discardedAttachments.add(channel);
          for (const observation of this.#turnObservations.get(params.sessionId)?.values() ?? []) {
            if (observation.attachment !== channel) continue;
            observation.dispose();
            this.#removeTurnObservation(observation);
          }
        }
        this.#detachAttachment(params.sessionId, newAttachment);
        await channel?.close().catch(() => undefined);
      }
      if (installedMcp && this.#mcps.get(params.sessionId) === installedMcp) {
        await this.#detachMcp(params.sessionId, installedMcp)
          ?.close()
          .catch(() => undefined);
      } else if (
        previousMcp &&
        previousMcpReconfigureAttempted &&
        previousMcpConfig &&
        this.#mcps.get(params.sessionId) === previousMcp
      ) {
        await previousMcp.reconfigure(previousMcpConfig).catch(() => undefined);
      }
      restoreContext?.rollback();
      restoreClient?.rollback();
      if (!alreadyOwned) this.#ownedSessionIds.delete(params.sessionId);
      if (error instanceof RequestError) throw error;
      throw requestErrorFromRuntimeHost(error, 'subscription.open');
    } finally {
      if (this.#sessionLoadControllers.get(params.sessionId) === loadController) {
        this.#sessionLoadControllers.delete(params.sessionId);
      }
      if (replayHistory) this.#historyReplays.delete(params.sessionId);
      for (const observation of heldObservations) observation.releaseLive();
      for (const observation of this.#turnObservations.get(params.sessionId)?.values() ?? []) {
        observation.releaseLive();
      }
    }
  }

  #recordLiveHistoryDelivery(
    sessionId: string,
    notification: SessionNotification,
    observation: AcpTurnObservation,
  ): void {
    const prefix = observation.recordDeliveredText(notification);
    const delivery = this.#historyReplayDelivery.get(sessionId);
    if (!delivery) return;
    const chunk = historyTextChunk(notification);
    if (chunk) {
      const previous = delivery.textByMessage.get(chunk.key) ?? '';
      delivery.textByMessage.set(
        chunk.key,
        prefix?.startsWith(previous) ? prefix : previous + chunk.text,
      );
    } else {
      delivery.otherUpdates.add(JSON.stringify(notification.update));
    }
  }

  async #deliverHistoryNotification(
    notification: SessionNotification,
    notify: AcpPromptContext['notify'],
    delivery: HistoryReplayDelivery,
  ): Promise<void> {
    const chunk = historyTextChunk(notification);
    if (chunk) {
      const previous = delivery.textByMessage.get(chunk.key) ?? '';
      const text = chunk.text.startsWith(previous) ? chunk.text.slice(previous.length) : chunk.text;
      if (!text) return;
      await notify({
        ...notification,
        update: {
          ...notification.update,
          content: { type: 'text', text },
        },
      } as SessionNotification);
      delivery.textByMessage.set(
        chunk.key,
        chunk.text.startsWith(previous) ? chunk.text : previous + chunk.text,
      );
      return;
    }
    const key = JSON.stringify(notification.update);
    if (delivery.otherUpdates.has(key)) return;
    await notify(notification);
    delivery.otherUpdates.add(key);
  }

  #queueLoad<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sessionLoadTails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.#sessionLoadTails.set(sessionId, result);
    void result.then(
      () => {
        if (this.#sessionLoadTails.get(sessionId) === result)
          this.#sessionLoadTails.delete(sessionId);
      },
      () => {
        if (this.#sessionLoadTails.get(sessionId) === result)
          this.#sessionLoadTails.delete(sessionId);
      },
    );
    return result;
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
    for (const observer of this.#domainObservations.values()) observer.dispose();
    this.#domainObservations.clear();
    this.#externalObservationContexts.clear();
    this.#externalContextLeases.clear();
    for (const observations of this.#turnObservations.values()) {
      for (const observation of observations.values()) {
        if (!(observation instanceof AcpAdmittedTurnObservation)) observation.dispose();
      }
    }
    const sessionIds = new Set([...this.#turnObservations.keys(), ...this.#attachments.keys()]);
    const observations = [...this.#turnObservations.values()].flatMap((turns) => [
      ...turns.values(),
    ]);
    const activePrompts = [...sessionIds].flatMap((sessionId) => this.#admittedTurns(sessionId));
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
        while (
          active.admission.dispatchStarted &&
          !active.admission.startRequestSettled &&
          !active.finished
        ) {
          await active.waitForChange();
        }
      }),
    );
    const unknownAdmissions = activePrompts.filter((active) => {
      const observed = active.attachment?.snapshot.rootTurn;
      const hasStopIdentity =
        observed?.turnId === active.turnId || active.admission.startedTurn !== undefined;
      return active.admission.dispatchStarted && !active.admission.settled && !hasStopIdentity;
    });
    await Promise.allSettled(
      observations
        .filter((observation) => unknownAdmissions.every((active) => active !== observation))
        .map((observation) => observation.stopTask),
    );
    if (unknownAdmissions.length > 0) {
      // At shutdown the attachment is already closed and each start request has
      // settled, leaving recovery/query as the only remaining fact source.
      // Close the owned connection so those reads cannot deadlock EOF cleanup.
      await Promise.allSettled([this.#closeOwnedConnection()]);
      for (const active of unknownAdmissions) {
        active.settleOnClose();
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
    this.#pendingPlanAdmissions.clear();
    this.#artifactOperations.clear();
    this.#artifactCleanupTasks.clear();
    this.#artifactUploads.clear();
    this.#ownedSessionIds.clear();
    this.#historyReplayDelivery.clear();
  }

  #closeOwnedConnection(): Promise<void> {
    this.#artifactConnectionDisposer?.();
    this.#artifactConnectionDisposer = undefined;
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

function validateNewSessionParams(
  params: Pick<NewSessionRequest, 'cwd' | 'additionalDirectories'>,
): void {
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

function historyTextChunk(
  notification: SessionNotification,
): { key: string; text: string } | undefined {
  const update = notification.update;
  if (
    update.sessionUpdate !== 'user_message_chunk' &&
    update.sessionUpdate !== 'agent_message_chunk' &&
    update.sessionUpdate !== 'agent_thought_chunk'
  )
    return;
  if (update.content.type !== 'text' || !update.messageId) return;
  return { key: `${update.sessionUpdate}:${update.messageId}`, text: update.content.text };
}
