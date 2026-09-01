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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import { createHash } from 'node:crypto';
import { authorizeConnectionModel } from '@maka/core/llm-connections';
import { isModelExplicitlyUnsupportedForChat } from '@maka/core/model-catalog';
import { thinkingVariantsForConnection } from '@maka/core/model-thinking';
import {
  executionBoundaryDisplayMode,
  type ExecutionBoundary,
  type ExecutionBoundarySummary,
} from '@maka/core/sandbox-boundary';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import { DEFAULT_SESSION_NAME, normalizeUserSessionName } from '@maka/core/session-name';
import {
  isSessionStartModeLabel as isExecutionSemanticLabel,
  sessionStartModeSpec,
} from '@maka/core/deep-research';
import {
  isWorkHubCoordinationSessionId,
  isWorkHubCoordinationSessionTarget,
  type SessionHeader,
  type SessionHeaderPatch,
} from '@maka/core/session';
import {
  isSessionNotFoundError,
  SessionMetadataConflictError,
  SessionMetadataVersionConflictError,
  SessionReadMarkerMessageNotFoundError,
  type SessionCatalogPageCursor,
  type SessionCatalogRecord,
  type SessionHeaderSnapshot,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import type { CreateStableSessionRequest } from '@maka/storage/session-store';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import {
  SessionConfigurationRevisionConflictError,
  SessionConfigurationTransitionError,
  type SessionManager,
} from '@maka/runtime/session-manager';
import {
  decodeSessionCatalogProjection,
  decodeSharedSessionCatalogProjection,
  SESSION_CATALOG_LIVE_RUN_STATE_SCHEMA_VERSION,
  SESSION_CATALOG_LABEL_MAX_BYTES,
  SESSION_CATALOG_LABEL_MAX_ITEMS,
  SESSION_CATALOG_MODEL_MAX_BYTES,
  SESSION_CATALOG_PAGE_MAX_ITEMS,
  SESSION_CATALOG_RESULT_MAX_BYTES,
  SESSION_CATALOG_RUNNING_TURN_MAX_ITEMS,
  type OperationError,
  type OperationOutcome,
  type SessionCatalogItem,
  type SessionCatalogLiveRunState,
  type SessionCatalogProjection,
  type SharedSessionCatalogProjection,
  type SessionCatalogQueryInput,
  type SessionCatalogQueryResult,
  type SessionCatalogRevision,
  type SessionConfigurationUpdateInput,
  type SessionCreateInput,
  type SessionWorkspaceRelocateInput,
  type SessionExecutionBoundaryQueryInput,
  type SessionMetadataUpdateInput,
  type SessionModelTarget,
  type SessionReadMarkerSetInput,
  type SessionUpdateResult,
  type SessionTurnsQueryInput,
  type SessionTurnLandmarksQueryInput,
  projectSessionTurnLandmarkForWire,
  SESSION_TURN_QUERY_RESULT_MAX_BYTES,
  projectSessionTurnContributionForWire,
} from '../protocol/index.js';
import type { SessionCatalogOperationHandlerMap } from './operation-dispatcher.js';
import type { RuntimeHostAccessAuthority } from './access-authority.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';
import type { SessionContinuityCoordinator } from './session-continuity-coordinator.js';
import { type HostWorkspaceResolver, WorkspaceResolutionError } from './workspace-resolver.js';

type SessionCatalogStores = Pick<
  ExecutionStoresWriter<'interactive'>['sessionStore'],
  | 'createStableSession'
  | 'listCatalogPage'
  | 'markSessionReadThroughMessage'
  | 'probeStableSessionCreate'
  | 'readCatalogRecord'
  | 'readExecutionBoundary'
  | 'readHeaderRecordSnapshot'
  | 'readTurnContributionsSnapshot'
  | 'readTurnLandmarksSnapshot'
  | 'updateHeaderVersioned'
>;

type SessionRuntimePolicyStores = {
  readonly connectionCatalog: Pick<RuntimePolicyStoresWriter['connectionCatalog'], 'getSnapshot'>;
  readonly runtimePolicy: Pick<RuntimePolicyStoresWriter['runtimePolicy'], 'getSnapshot'>;
  readonly operations: Pick<RuntimePolicyStoresWriter['operations'], 'resolveExecutionConnection'>;
};

type SessionConfigurationAuthority = Pick<
  SessionManager,
  'transitionSessionConfiguration' | 'relocateSessionWorkspace' | 'runningTurnIds'
>;
type SessionContinuity = Pick<SessionContinuityCoordinator, 'refreshCanonical'>;

interface ResolvedSessionConfiguration {
  readonly backend: 'ai-sdk';
  readonly llmConnectionId?: string;
  readonly llmConnectionSlug: string;
  readonly model: string;
  readonly thinkingLevel: SessionHeader['thinkingLevel'];
  readonly connectionLocked: boolean;
  readonly permissionMode: SessionHeader['permissionMode'];
  readonly collaborationMode: NonNullable<SessionHeader['collaborationMode']>;
  readonly orchestrationMode: NonNullable<SessionHeader['orchestrationMode']>;
}

export type SessionOperationFailureCode =
  | 'operation_unavailable'
  | 'invalid_request'
  | 'persistence_failed'
  | 'operation_conflict';

export class SessionOperationFailure extends Error {
  constructor(
    readonly code: SessionOperationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionOperationFailure';
  }
}

export interface HostSessionCatalogCoordinatorOptions {
  readonly stores: SessionCatalogStores;
  readonly runtimePolicy: SessionRuntimePolicyStores;
  readonly manager: SessionConfigurationAuthority;
  readonly admission: SessionAdmissionGate;
  readonly continuity: SessionContinuity;
  readonly workspaceResolver: HostWorkspaceResolver;
  readonly requestDrain: () => void;
  readonly sessionAccessAuthority?: Pick<
    RuntimeHostAccessAuthority,
    'activeSessionGrantForPrincipal'
  >;
}

interface ResolvedSessionModel {
  readonly connectionId: string;
  readonly connectionSlug: string;
  readonly model: string;
}

/** Host-owned Session catalog, creation, and configuration authority. */
export class HostSessionCatalogCoordinator {
  readonly handlers: SessionCatalogOperationHandlerMap = {
    'session.shared.query': (_input, context) => this.#querySharedSession(context.principal),
    'session.catalog.query': (input) => this.#query(input),
    'session.create': (input) => this.#create(input),
    'session.metadata.update': (input) => this.#updateMetadata(input),
    'session.configuration.update': (input) => this.#updateConfiguration(input),
    'session.workspace.relocate': (input) => this.#relocateWorkspace(input),
    'session.read_marker.set': (input) => this.#setReadMarker(input),
    'session.execution_boundary.query': (input) => this.#queryExecutionBoundary(input),
    'session.turn_landmarks.query': (input) => this.#queryTurnLandmarks(input),
    'session.turns.query': (input) => this.#queryTurns(input),
  };

  readonly #stores: SessionCatalogStores;
  readonly #runtimePolicy: SessionRuntimePolicyStores;
  readonly #manager: SessionConfigurationAuthority;
  readonly #admission: SessionAdmissionGate;
  readonly #continuity: SessionContinuity;
  readonly #workspaceResolver: HostWorkspaceResolver;
  readonly #requestDrain: () => void;
  readonly #sessionAccessAuthority:
    | Pick<RuntimeHostAccessAuthority, 'activeSessionGrantForPrincipal'>
    | undefined;

  constructor(options: HostSessionCatalogCoordinatorOptions) {
    this.#stores = options.stores;
    this.#runtimePolicy = options.runtimePolicy;
    this.#manager = options.manager;
    this.#admission = options.admission;
    this.#continuity = options.continuity;
    this.#workspaceResolver = options.workspaceResolver;
    this.#requestDrain = options.requestDrain;
    this.#sessionAccessAuthority = options.sessionAccessAuthority;
  }

  async resolveExternalSessionImportTarget(): Promise<Omit<CreateSessionInput, 'cwd' | 'name'>> {
    const [model, policy] = await Promise.all([
      this.#resolveModel({ kind: 'default' }, undefined),
      this.#readRuntimePolicy(),
    ]);
    return {
      llmConnectionId: model.connectionId,
      llmConnectionSlug: model.connectionSlug,
      model: model.model,
      permissionMode: policy.policy.chatDefaults.permissionMode,
      collaborationMode: 'agent',
      orchestrationMode: 'default',
    };
  }

  async createForHost(input: SessionCreateInput): Promise<void> {
    const outcome = await this.#create(input);
    if (!outcome.ok) throw new Error(outcome.error.message);
  }

  /** WorkHub Action Gate path; callers cannot bypass the typed operation outcome. */
  createForWorkHub(input: SessionCreateInput): Promise<OperationOutcome<'session.create'>> {
    return this.#create(input);
  }

  /** Prepare external facts before WorkHub commits create + assignment atomically. */
  async prepareWorkHubCreate(input: SessionCreateInput): Promise<CreateStableSessionRequest> {
    const prepared = await prepareCreate(input);
    return this.#workspaceResolver.runWithUsageRecorded(input.workspace, async (workspace) => {
      const [model, policy] = await Promise.all([
        this.#resolveModel(input.modelTarget, input.thinkingLevel),
        this.#readRuntimePolicy(),
      ]);
      return {
        sessionId: input.sessionId,
        requestFingerprint: createRequestFingerprint(input, prepared),
        input: {
          cwd: workspace.cwd,
          ...(workspace.projectId === null ? {} : { projectId: workspace.projectId }),
          name: prepared.name,
          labels: [...prepared.labels],
          llmConnectionId: model.connectionId,
          llmConnectionSlug: model.connectionSlug,
          model: model.model,
          ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
          ...(input.toolProfile === undefined ? {} : { toolProfile: input.toolProfile }),
          permissionMode: prepared.permissionMode ?? policy.policy.chatDefaults.permissionMode,
          collaborationMode: input.collaborationMode ?? 'agent',
          orchestrationMode: input.orchestrationMode ?? 'default',
        },
      };
    });
  }

  async #query(
    input: SessionCatalogQueryInput,
  ): Promise<OperationOutcome<'session.catalog.query'>> {
    try {
      if (input.kind === 'get') {
        const record = await this.#readCatalogRecordIfPresent(input.sessionId);
        return successQuery({
          kind: 'session',
          session: record ? this.#projectCatalogQueryRecord(record) : null,
        });
      }

      const cursor = input.kind === 'list_start' ? undefined : decodeCursor(input.cursor);
      if (input.kind === 'list_continue' && cursor === undefined) {
        return queryFailure('invalid_request', 'Session cursor is invalid');
      }
      const pageResult = await this.#stores.listCatalogPage(
        undefined,
        cursor,
        SESSION_CATALOG_PAGE_MAX_ITEMS,
        input.kind === 'list_continue' ? input.revision : undefined,
      );
      if (pageResult.kind === 'revision_changed') {
        return successQuery({
          kind: 'revision_changed',
          expectedRevision: pageResult.expectedRevision,
          actualRevision: pageResult.actualRevision,
        });
      }
      return successQuery(
        page(pageResult.records, pageResult.revision, pageResult.hasMore, (record) =>
          this.#projectCatalogQueryRecord(record),
        ),
      );
    } catch {
      return queryFailure('persistence_failed', 'Session catalog is unavailable');
    }
  }

  async #querySharedSession(
    principalId: string,
  ): Promise<OperationOutcome<'session.shared.query'>> {
    if (!this.#sessionAccessAuthority) {
      return {
        ok: false,
        error: { code: 'operation_unavailable', message: 'Session sharing is unavailable' },
      };
    }
    const grant = this.#sessionAccessAuthority.activeSessionGrantForPrincipal(
      principalId,
      'session_observation',
    );
    if (!grant) return { ok: true, result: { session: null } };
    try {
      const record = await this.#readCatalogRecordIfPresent(grant.sessionId);
      const currentGrant = this.#sessionAccessAuthority.activeSessionGrantForPrincipal(
        principalId,
        'session_observation',
      );
      if (currentGrant?.grantId !== grant.grantId) {
        return { ok: true, result: { session: null } };
      }
      return {
        ok: true,
        result: {
          session: record
            ? projectSharedSessionCatalogRecord(
                record,
                projectCatalogLiveRunState(this.#manager.runningTurnIds(record.header.id)),
              )
            : null,
        },
      };
    } catch {
      return {
        ok: false,
        error: { code: 'persistence_failed', message: 'Shared Session catalog is unavailable' },
      };
    }
  }

  #projectCatalogQueryRecord(record: SessionCatalogRecord): SessionCatalogItem {
    return projectSessionCatalogRecord(
      record,
      projectCatalogLiveRunState(this.#manager.runningTurnIds(record.header.id)),
    );
  }

  async #queryExecutionBoundary(
    input: SessionExecutionBoundaryQueryInput,
  ): Promise<OperationOutcome<'session.execution_boundary.query'>> {
    try {
      return {
        ok: true,
        result: projectExecutionBoundary(await this.#stores.readExecutionBoundary(input.sessionId)),
      };
    } catch (error) {
      if (isNotFound(error)) {
        return executionBoundaryFailure('not_found', 'Session does not exist');
      }
      return executionBoundaryFailure(
        'persistence_failed',
        'Session execution boundary is unavailable',
      );
    }
  }

  async #queryTurns(
    input: SessionTurnsQueryInput,
  ): Promise<OperationOutcome<'session.turns.query'>> {
    try {
      let maxContributions = input.maxContributions;
      let throughSequence = input.throughSequence;
      while (true) {
        const page = await this.#stores.readTurnContributionsSnapshot(
          input.sessionId,
          throughSequence,
          input.position,
          maxContributions,
        );
        throughSequence = page.throughSequence;
        const result = {
          sessionId: input.sessionId,
          throughSequence: page.throughSequence,
          contributions: page.contributions.map(projectSessionTurnContributionForWire),
          nextPosition: page.nextPosition,
        };
        const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
        if (resultBytes <= SESSION_TURN_QUERY_RESULT_MAX_BYTES) {
          return { ok: true, result };
        }
        if (maxContributions === 1) {
          throw new Error('Session turn contribution exceeds the wire limit');
        }
        maxContributions = Math.max(
          1,
          Math.min(
            maxContributions - 1,
            Math.floor(
              (page.contributions.length * SESSION_TURN_QUERY_RESULT_MAX_BYTES) / resultBytes,
            ),
          ),
        );
      }
    } catch (error) {
      if (isNotFound(error)) return turnsFailure('not_found', 'Session does not exist');
      return turnsFailure('persistence_failed', 'Session turns are unavailable');
    }
  }

  async #queryTurnLandmarks(
    input: SessionTurnLandmarksQueryInput,
  ): Promise<OperationOutcome<'session.turn_landmarks.query'>> {
    try {
      const snapshot = await this.#stores.readTurnLandmarksSnapshot(
        input.sessionId,
        input.maxLandmarks,
      );
      return {
        ok: true,
        result: {
          sessionId: input.sessionId,
          throughSequence: snapshot.throughSequence,
          landmarks: snapshot.landmarks.map(projectSessionTurnLandmarkForWire),
        },
      };
    } catch (error) {
      if (isNotFound(error)) {
        return turnLandmarksFailure('not_found', 'Session does not exist');
      }
      return turnLandmarksFailure('persistence_failed', 'Session turn landmarks are unavailable');
    }
  }

  async #create(input: SessionCreateInput): Promise<OperationOutcome<'session.create'>> {
    if (isWorkHubCoordinationSessionId(input.sessionId)) {
      return createFailure(
        'operation_conflict',
        'Session identity is reserved for WorkHub coordination',
      );
    }
    let prepared: PreparedSessionCreate;
    try {
      prepared = await prepareCreate(input);
    } catch (error) {
      return createOperationFailure(error, 'invalid_request');
    }

    return this.#admission.run(input.sessionId, async (lease) => {
      let commitAttempted = false;
      const requestFingerprint = createRequestFingerprint(input, prepared);
      try {
        const probe = await this.#stores.probeStableSessionCreate(
          input.sessionId,
          requestFingerprint,
        );
        if (probe.kind === 'existing') {
          return createSuccess(
            projectSessionCatalogRecord(await this.#stores.readCatalogRecord(input.sessionId)),
          );
        }
        if (probe.kind === 'conflict') {
          return createFailure(
            'operation_conflict',
            'Session identity belongs to a different create request',
          );
        }
        return await this.#workspaceResolver.runWithUsageRecorded(
          input.workspace,
          async (workspace) => {
            const [model, policy] = await Promise.all([
              this.#resolveModel(input.modelTarget, input.thinkingLevel),
              this.#readRuntimePolicy(),
            ]);
            const createInput: CreateSessionInput = {
              cwd: workspace.cwd,
              ...(workspace.projectId === null ? {} : { projectId: workspace.projectId }),
              name: prepared.name,
              labels: [...prepared.labels],
              llmConnectionId: model.connectionId,
              llmConnectionSlug: model.connectionSlug,
              model: model.model,
              ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
              ...(input.toolProfile === undefined ? {} : { toolProfile: input.toolProfile }),
              permissionMode: prepared.permissionMode ?? policy.policy.chatDefaults.permissionMode,
              collaborationMode: input.collaborationMode ?? 'agent',
              orchestrationMode: input.orchestrationMode ?? 'default',
            };
            commitAttempted = true;
            const result = await this.#stores.createStableSession({
              sessionId: input.sessionId,
              requestFingerprint,
              input: createInput,
            });
            if (result.kind === 'conflict') {
              return createFailure(
                'operation_conflict',
                'Session identity belongs to a different create request',
              );
            }
            await this.#continuity.refreshCanonical(input.sessionId, lease);
            return createSuccess(
              projectSessionCatalogRecord(await this.#stores.readCatalogRecord(input.sessionId)),
            );
          },
        );
      } catch (error) {
        if (error instanceof SessionOperationFailure || error instanceof WorkspaceResolutionError) {
          return createFailure(
            error.code === 'not_found' ? 'operation_conflict' : error.code,
            error.message,
          );
        }
        this.#requestDrain();
        if (!commitAttempted) {
          return createFailure('persistence_failed', 'Session creation authority is unavailable');
        }
        return createFailure('commit_outcome_unknown', 'Session creation outcome is unknown');
      }
    });
  }

  #updateMetadata(
    input: SessionMetadataUpdateInput,
  ): Promise<OperationOutcome<'session.metadata.update'>> {
    if (isWorkHubCoordinationSessionId(input.sessionId)) {
      return Promise.resolve(
        metadataFailure(
          'operation_unavailable',
          'WorkHub Coordination Session metadata requires WorkHub authority',
        ),
      );
    }
    return this.#admission.run(input.sessionId, async (lease) => {
      try {
        const current = await this.#stores.readHeaderRecordSnapshot(input.sessionId);
        if (isWorkHubCoordinationSessionTarget(current.header)) {
          throw new SessionOperationFailure(
            'operation_unavailable',
            'WorkHub Coordination Session metadata requires WorkHub authority',
          );
        }
        const labels =
          input.patch.labels === undefined
            ? undefined
            : replaceUserLabels(current, input.expectedRevision, input.patch.labels);
        const patch: SessionHeaderPatch = {
          ...(input.patch.name === undefined ? {} : normalizeSessionNamePatch(input.patch.name)),
          ...(labels === undefined ? {} : { labels }),
          ...(input.patch.isFlagged === undefined ? {} : { isFlagged: input.patch.isFlagged }),
        };
        await this.#stores.updateHeaderVersioned(input.sessionId, patch, input.expectedRevision);
        return updateSuccess(await this.#committedUpdate(input.sessionId, lease));
      } catch (error) {
        return this.#metadataMutationFailure(
          input,
          error,
          'Session metadata update outcome is unknown',
        );
      }
    });
  }

  async #updateConfiguration(
    input: SessionConfigurationUpdateInput,
  ): Promise<OperationOutcome<'session.configuration.update'>> {
    if (isWorkHubCoordinationSessionId(input.sessionId)) {
      return configurationFailure(
        'operation_conflict',
        'WorkHub Coordination Session configuration requires WorkHub authority',
      );
    }
    return this.#admission.run(input.sessionId, async (lease) => {
      let commitAttempted = false;
      try {
        const current = await this.#stores.readHeaderRecordSnapshot(input.sessionId);
        if (isWorkHubCoordinationSessionTarget(current.header)) {
          return configurationFailure(
            'operation_conflict',
            'WorkHub Coordination Session configuration requires WorkHub authority',
          );
        }
        if (current.revision !== input.expectedRevision) {
          return configurationSuccess(revisionConflict(input.expectedRevision, current.revision));
        }
        if (current.header.isArchived) {
          return configurationFailure(
            'operation_conflict',
            'Archived Session configuration cannot be changed',
          );
        }

        const configuration = await this.#mergeConfigurationPatch(current.header, input.patch);
        const clearsConnectionBlock =
          input.patch.modelTarget !== undefined &&
          current.header.blockedReason === 'NO_REAL_CONNECTION';
        if (!clearsConnectionBlock && sessionConfigurationMatches(current.header, configuration)) {
          return configurationSuccess({
            kind: 'committed',
            session: projectSessionCatalogRecord(
              await this.#stores.readCatalogRecord(input.sessionId),
            ),
          });
        }
        commitAttempted = true;
        await this.#manager.transitionSessionConfiguration(input.sessionId, {
          expectedRevision: input.expectedRevision,
          clearConnectionBlock: input.patch.modelTarget !== undefined,
          configuration,
        });
        return configurationSuccess(await this.#committedUpdate(input.sessionId, lease));
      } catch (error) {
        if (
          !commitAttempted &&
          !isNotFound(error) &&
          !(error instanceof SessionMetadataVersionConflictError) &&
          !(error instanceof SessionMetadataConflictError) &&
          !(error instanceof SessionConfigurationRevisionConflictError) &&
          !(error instanceof SessionConfigurationTransitionError) &&
          !(error instanceof SessionOperationFailure)
        ) {
          this.#requestDrain();
          return configurationFailure(
            'persistence_failed',
            'Session configuration authority is unavailable',
          );
        }
        return this.#configurationMutationFailure(
          input,
          error,
          'Session configuration update outcome is unknown',
        );
      }
    });
  }

  async #relocateWorkspace(
    input: SessionWorkspaceRelocateInput,
  ): Promise<OperationOutcome<'session.workspace.relocate'>> {
    if (isWorkHubCoordinationSessionId(input.sessionId)) {
      return workspaceFailure(
        'operation_conflict',
        'WorkHub Coordination Session workspace requires WorkHub authority',
      );
    }
    return this.#admission.run(input.sessionId, async (lease) => {
      let commitAttempted = false;
      try {
        const current = await this.#stores.readHeaderRecordSnapshot(input.sessionId);
        if (isWorkHubCoordinationSessionTarget(current.header)) {
          return workspaceFailure(
            'operation_conflict',
            'WorkHub Coordination Session workspace requires WorkHub authority',
          );
        }
        if (current.revision !== input.expectedRevision) {
          return workspaceSuccess(revisionConflict(input.expectedRevision, current.revision));
        }
        await this.#workspaceResolver.run(input.workspace, async (workspace) => {
          commitAttempted = true;
          await this.#manager.relocateSessionWorkspace(input.sessionId, {
            expectedRevision: input.expectedRevision,
            cwd: workspace.cwd,
            projectId: workspace.projectId,
          });
        });
        return workspaceSuccess(await this.#committedUpdate(input.sessionId, lease));
      } catch (error) {
        if (isNotFound(error)) return workspaceFailure('not_found', 'Session does not exist');
        if (error instanceof SessionConfigurationRevisionConflictError) {
          return workspaceSuccess(revisionConflict(input.expectedRevision, error.actualRevision));
        }
        if (error instanceof SessionConfigurationTransitionError) {
          return workspaceFailure(error.code, error.message);
        }
        if (error instanceof SessionOperationFailure || error instanceof WorkspaceResolutionError) {
          return workspaceFailure(error.code, error.message);
        }
        if (!commitAttempted) {
          this.#requestDrain();
          return workspaceFailure(
            'persistence_failed',
            'Session workspace authority is unavailable',
          );
        }
        this.#requestDrain();
        return workspaceFailure(
          'commit_outcome_unknown',
          'Session workspace relocation outcome is unknown',
        );
      }
    });
  }

  #setReadMarker(
    input: SessionReadMarkerSetInput,
  ): Promise<OperationOutcome<'session.read_marker.set'>> {
    return this.#admission.run(input.sessionId, async (lease) => {
      try {
        const current = await this.#stores.readHeaderRecordSnapshot(input.sessionId);
        if (isWorkHubCoordinationSessionTarget(current.header)) {
          return readMarkerFailure(
            'operation_conflict',
            'WorkHub Coordination Session read state requires WorkHub authority',
          );
        }
        await this.#stores.markSessionReadThroughMessage(
          input.sessionId,
          input.readThroughMessageId,
        );
        await this.#continuity.refreshCanonical(input.sessionId, lease);
        return {
          ok: true,
          result: projectSessionCatalogRecord(
            await this.#stores.readCatalogRecord(input.sessionId),
          ),
        };
      } catch (error) {
        if (isNotFound(error)) return readMarkerFailure('not_found', 'Session does not exist');
        if (error instanceof SessionReadMarkerMessageNotFoundError) {
          return readMarkerFailure('invalid_request', error.message);
        }
        if (error instanceof SessionMetadataVersionConflictError) {
          return readMarkerFailure(
            'operation_conflict',
            'Session changed while advancing the read marker',
          );
        }
        this.#requestDrain();
        return readMarkerFailure(
          'commit_outcome_unknown',
          'Session read marker outcome is unknown',
        );
      }
    });
  }

  async #committedUpdate(
    sessionId: string,
    lease: SessionAdmissionLease,
  ): Promise<SessionUpdateResult> {
    await this.#continuity.refreshCanonical(sessionId, lease);
    return {
      kind: 'committed',
      session: projectSessionCatalogRecord(await this.#stores.readCatalogRecord(sessionId)),
    };
  }

  #metadataMutationFailure(
    input: SessionMetadataUpdateInput,
    error: unknown,
    unknownMessage: string,
  ): OperationOutcome<'session.metadata.update'> {
    if (isNotFound(error)) return metadataFailure('not_found', 'Session does not exist');
    if (error instanceof SessionMetadataVersionConflictError) {
      return updateSuccess(revisionConflict(input.expectedRevision, error.actualVersion));
    }
    if (error instanceof SessionOperationFailure) {
      return metadataFailure(
        error.code === 'operation_unavailable' ? 'operation_unavailable' : 'invalid_request',
        error.message,
      );
    }
    if (error instanceof SessionMetadataConflictError) {
      return metadataFailure('invalid_request', error.message);
    }
    this.#requestDrain();
    return metadataFailure('commit_outcome_unknown', unknownMessage);
  }

  #configurationMutationFailure(
    input: SessionConfigurationUpdateInput,
    error: unknown,
    unknownMessage: string,
  ): OperationOutcome<'session.configuration.update'> {
    if (isNotFound(error)) return configurationFailure('not_found', 'Session does not exist');
    if (error instanceof SessionMetadataVersionConflictError) {
      return configurationSuccess(revisionConflict(input.expectedRevision, error.actualVersion));
    }
    if (error instanceof SessionConfigurationRevisionConflictError) {
      return configurationSuccess(revisionConflict(input.expectedRevision, error.actualRevision));
    }
    if (error instanceof SessionConfigurationTransitionError) {
      return configurationFailure(error.code, error.message);
    }
    if (error instanceof SessionOperationFailure) {
      return configurationFailure(error.code, error.message);
    }
    if (error instanceof SessionMetadataConflictError) {
      return configurationFailure('operation_conflict', error.message);
    }
    this.#requestDrain();
    return configurationFailure('commit_outcome_unknown', unknownMessage);
  }

  async #readCatalogRecordIfPresent(sessionId: string): Promise<SessionCatalogRecord | undefined> {
    try {
      return await this.#stores.readCatalogRecord(sessionId);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async #resolveModel(
    target: SessionModelTarget,
    thinkingLevel: SessionCreateInput['thinkingLevel'],
  ): Promise<ResolvedSessionModel> {
    const selected = await this.#selectModelTarget(target);
    const readiness = await this.#runtimePolicy.operations.resolveExecutionConnection({
      kind: 'bound',
      connectionId: selected.connectionId,
      connectionSlug: selected.connectionSlug,
    });
    if (
      selected.connectionId !== undefined &&
      (readiness.kind === 'not_found' || readiness.kind === 'identity_mismatch')
    ) {
      throw new SessionOperationFailure(
        'operation_conflict',
        'Session model identity changed during selection',
      );
    }
    if (
      readiness.kind === 'not_found' ||
      readiness.kind === 'identity_mismatch' ||
      readiness.kind === 'disabled'
    ) {
      throw new SessionOperationFailure(
        'invalid_request',
        'Session model connection is unavailable',
      );
    }
    if (readiness.kind === 'credential_not_configured') {
      throw new SessionOperationFailure(
        'operation_unavailable',
        'Session model connection is not ready',
      );
    }
    // Refused before the Session is committed, not when a backend is later
    // built for it: an upgraded installation keeps the credential, so nothing
    // downstream of here would notice on its own. Covers the default target and
    // an explicit one alike, which is what reaches Bot, CLI and scheduled runs.
    if (readiness.kind === 'provider_retired') {
      throw new SessionOperationFailure(
        'invalid_request',
        'Session model connection uses a sign-in that was removed from Maka',
      );
    }
    if (
      selected.connectionId !== undefined &&
      readiness.connection.connectionId !== selected.connectionId
    ) {
      throw new SessionOperationFailure(
        'operation_conflict',
        'Default Session model changed during selection',
      );
    }
    const connection = readiness.connection;
    const model = authorizeConnectionModel(connection, selected.modelId);
    if (!model) {
      throw new SessionOperationFailure('invalid_request', 'Session model is not enabled');
    }
    if (isModelExplicitlyUnsupportedForChat(model)) {
      throw new SessionOperationFailure('invalid_request', 'Session model is not chat-capable');
    }
    if (Buffer.byteLength(selected.modelId, 'utf8') > SESSION_CATALOG_MODEL_MAX_BYTES) {
      throw new SessionOperationFailure(
        'invalid_request',
        'Session model identifier exceeds the wire limit',
      );
    }
    // Fail-closed for undeclared levels only: the catalog entry carries the
    // typed `relayModelProfiles` table, so a relay's user-declared levels DO
    // reach this gate. A level outside the resolved variants is still
    // rejected — execution-model-authority rebuilds the runtime connection
    // from the same table, so whatever passes here is exactly what the wire
    // can send.
    if (
      thinkingLevel !== undefined &&
      !thinkingVariantsForConnection(
        {
          providerType: connection.providerType,
          relayModelProfiles: connection.relayModelProfiles,
        },
        selected.modelId,
      ).includes(thinkingLevel)
    ) {
      throw new SessionOperationFailure(
        'invalid_request',
        `Session model does not support thinking level ${thinkingLevel}`,
      );
    }
    return {
      connectionId: connection.connectionId,
      connectionSlug: connection.slug,
      model: selected.modelId,
    };
  }

  async #selectModelTarget(target: SessionModelTarget): Promise<{
    readonly connectionSlug: string;
    readonly connectionId: string;
    readonly modelId: string;
  }> {
    if (target.kind === 'explicit') {
      return {
        connectionId: target.connectionId,
        connectionSlug: target.connectionSlug,
        modelId: target.model,
      };
    }
    let snapshot;
    try {
      snapshot = await this.#runtimePolicy.connectionCatalog.getSnapshot();
    } catch {
      throw new SessionOperationFailure('persistence_failed', 'Connection catalog is unavailable');
    }
    if (!snapshot.defaultTarget) {
      throw new SessionOperationFailure(
        'operation_unavailable',
        'No default Session model is configured',
      );
    }
    const connection = snapshot.connections.find(
      (candidate) => candidate.connectionId === snapshot.defaultTarget?.connectionId,
    );
    if (!connection) {
      throw new SessionOperationFailure(
        'invalid_request',
        'Default Session model connection does not exist',
      );
    }
    return {
      connectionSlug: connection.slug,
      connectionId: connection.connectionId,
      modelId: snapshot.defaultTarget.modelId,
    };
  }

  async #mergeConfigurationPatch(
    current: SessionHeader,
    patch: SessionConfigurationUpdateInput['patch'],
  ): Promise<ResolvedSessionConfiguration> {
    if (current.llmConnectionId === undefined && patch.modelTarget === undefined) {
      throw new SessionOperationFailure(
        'operation_conflict',
        'Legacy Session configuration requires an explicit account selection',
      );
    }
    const thinkingLevel =
      patch.thinkingLevel === undefined
        ? current.thinkingLevel
        : (patch.thinkingLevel ?? undefined);
    let model: {
      readonly connectionId?: string;
      readonly connectionSlug: string;
      readonly model: string;
    } = {
      ...(current.llmConnectionId === undefined ? {} : { connectionId: current.llmConnectionId }),
      connectionSlug: current.llmConnectionSlug,
      model: current.model,
    };
    if (patch.modelTarget !== undefined) {
      model = await this.#resolveModel(patch.modelTarget, thinkingLevel);
    } else if (patch.thinkingLevel !== undefined && current.llmConnectionId !== undefined) {
      const connectionId = current.llmConnectionId;
      model = await this.#resolveModel(
        {
          kind: 'explicit',
          connectionId,
          connectionSlug: current.llmConnectionSlug,
          model: current.model,
        },
        thinkingLevel,
      );
    }
    return {
      backend: 'ai-sdk',
      ...(model.connectionId === undefined ? {} : { llmConnectionId: model.connectionId }),
      llmConnectionSlug: model.connectionSlug,
      model: model.model,
      thinkingLevel,
      connectionLocked: patch.modelTarget === undefined ? current.connectionLocked : true,
      permissionMode: patch.permissionMode ?? current.permissionMode,
      collaborationMode: patch.collaborationMode ?? current.collaborationMode ?? 'agent',
      orchestrationMode: patch.orchestrationMode ?? current.orchestrationMode ?? 'default',
    };
  }

  async #readRuntimePolicy(): Promise<
    Awaited<ReturnType<SessionRuntimePolicyStores['runtimePolicy']['getSnapshot']>>
  > {
    try {
      return await this.#runtimePolicy.runtimePolicy.getSnapshot();
    } catch {
      throw new SessionOperationFailure('persistence_failed', 'Runtime policy is unavailable');
    }
  }
}

function sessionConfigurationMatches(
  header: SessionHeader,
  configuration: ResolvedSessionConfiguration,
): boolean {
  return (
    header.backend === 'ai-sdk' &&
    header.llmConnectionId === configuration.llmConnectionId &&
    header.llmConnectionSlug === configuration.llmConnectionSlug &&
    header.model === configuration.model &&
    header.thinkingLevel === configuration.thinkingLevel &&
    header.connectionLocked === configuration.connectionLocked &&
    header.permissionMode === configuration.permissionMode &&
    (header.collaborationMode ?? 'agent') === configuration.collaborationMode &&
    (header.orchestrationMode ?? 'default') === configuration.orchestrationMode
  );
}

interface PreparedSessionCreate {
  readonly name: string;
  readonly labels: readonly string[];
  readonly permissionMode?: SessionCreateInput['permissionMode'];
}

async function prepareCreate(input: SessionCreateInput): Promise<PreparedSessionCreate> {
  if (input.labels?.some(isExecutionSemanticLabel)) {
    throw new SessionOperationFailure(
      'invalid_request',
      'Session creation cannot set reserved execution labels',
    );
  }
  const mode = input.mode === undefined ? undefined : sessionStartModeSpec(input.mode);
  if (mode === undefined && input.permissionMode === 'explore') {
    throw new SessionOperationFailure(
      'invalid_request',
      'Session creation requires a declared mode for explore permission',
    );
  }
  const name = normalizedSessionName(mode?.name ?? input.name ?? DEFAULT_SESSION_NAME);
  const labels = [...(input.labels ?? []), ...(mode?.labels ?? [])];
  const permissionMode = mode?.permissionMode ?? input.permissionMode;
  return {
    name,
    labels,
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };
}

function createRequestFingerprint(
  input: SessionCreateInput,
  prepared: PreparedSessionCreate,
): string {
  const identity = [
    'session.create.v4',
    input.sessionId,
    input.workspace.kind === 'project'
      ? ['project', input.workspace.projectId]
      : ['host_path', input.workspace.path],
    prepared.name,
    prepared.labels,
    input.modelTarget.kind === 'default'
      ? ['default']
      : [
          'explicit',
          input.modelTarget.connectionId,
          input.modelTarget.connectionSlug,
          input.modelTarget.model,
        ],
    input.thinkingLevel ?? null,
    input.toolProfile ?? null,
    prepared.permissionMode ?? ['runtime_default'],
    input.collaborationMode ?? 'agent',
    input.orchestrationMode ?? 'default',
  ];
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

export function projectSessionCatalogRecord(
  record: SessionCatalogRecord,
  liveRunState?: SessionCatalogLiveRunState,
): SessionCatalogItem {
  const { header, summary } = record;
  const projectedLabels = projectCatalogLabels(header.labels);
  const projection: SessionCatalogProjection = {
    id: header.id,
    revision: record.revision,
    workspace: {
      target:
        typeof header.projectId === 'string'
          ? { kind: 'project', projectId: header.projectId }
          : { kind: 'host_path', path: header.cwd },
      hostCwd: header.cwd,
    },
    createdAt: header.createdAt,
    activityAt: record.activityAt,
    name: header.name,
    isFlagged: header.isFlagged,
    isArchived: header.isArchived,
    labels: projectedLabels.labels,
    labelsTruncated: projectedLabels.truncated,
    hasUnread: header.hasUnread,
    ...(header.lastReadMessageId === undefined
      ? {}
      : { lastReadMessageId: header.lastReadMessageId }),
    ...(summary.lastMessageAt === undefined ? {} : { lastMessageAt: summary.lastMessageAt }),
    ...(summary.lastMessagePreview === undefined
      ? {}
      : { lastMessagePreview: summary.lastMessagePreview }),
    status: header.status,
    ...(liveRunState === undefined ? {} : { liveRunState }),
    ...(header.blockedReason === undefined ? {} : { blockedReason: header.blockedReason }),
    ...(header.statusUpdatedAt === undefined ? {} : { statusUpdatedAt: header.statusUpdatedAt }),
    ...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
    ...(header.branchOfTurnId === undefined ? {} : { branchOfTurnId: header.branchOfTurnId }),
    ...(header.subagentParent === undefined
      ? {}
      : {
          subagent: {
            parentSessionId: header.subagentParent.parentSessionId,
            ...(header.subagentRuntime?.agentId === undefined
              ? {}
              : { agentId: header.subagentRuntime.agentId }),
            ...(header.subagentRuntime?.agentName === undefined
              ? {}
              : { agentName: header.subagentRuntime.agentName }),
            ...(header.subagentRuntime?.profile === undefined
              ? {}
              : { profile: header.subagentRuntime.profile }),
          },
        }),
    ...(header.revisionRootSessionId === undefined
      ? {}
      : { revisionRootSessionId: header.revisionRootSessionId }),
    ...(header.revisionParentSessionId === undefined
      ? {}
      : { revisionParentSessionId: header.revisionParentSessionId }),
    ...(header.revisionOfTurnId === undefined ? {} : { revisionOfTurnId: header.revisionOfTurnId }),
    ...(header.revisionIndex === undefined ? {} : { revisionIndex: header.revisionIndex }),
    ...(header.revisionState === undefined ? {} : { revisionState: header.revisionState }),
    backend: header.backend,
    llmConnectionId: header.llmConnectionId ?? null,
    llmConnectionSlug: header.llmConnectionSlug,
    connectionLocked: header.connectionLocked,
    model: header.model,
    ...(header.thinkingLevel === undefined ? {} : { thinkingLevel: header.thinkingLevel }),
    permissionMode: header.permissionMode,
    collaborationMode: header.collaborationMode ?? 'agent',
    orchestrationMode: header.orchestrationMode ?? 'default',
  };
  try {
    return decodeSessionCatalogProjection(projection);
  } catch (error) {
    if (!(error instanceof RuntimeHostProtocolError) || error.code !== 'invalid_frame') throw error;
    return {
      kind: 'unsupported_legacy_record',
      id: header.id,
      revision: record.revision,
      reason: 'not_wire_representable',
    };
  }
}

function projectSharedSessionCatalogRecord(
  record: SessionCatalogRecord,
  liveRunState?: SessionCatalogLiveRunState,
): SharedSessionCatalogProjection {
  const { header, summary } = record;
  const shared: SharedSessionCatalogProjection = {
    kind: 'shared_session',
    id: header.id,
    revision: record.revision,
    createdAt: header.createdAt,
    activityAt: record.activityAt,
    name: header.name,
    ...(summary.lastMessageAt === undefined ? {} : { lastMessageAt: summary.lastMessageAt }),
    ...(summary.lastMessagePreview === undefined
      ? {}
      : { lastMessagePreview: summary.lastMessagePreview }),
    status: header.status,
    ...(liveRunState === undefined ? {} : { liveRunState }),
    ...(header.blockedReason === undefined ? {} : { blockedReason: header.blockedReason }),
    ...(header.statusUpdatedAt === undefined ? {} : { statusUpdatedAt: header.statusUpdatedAt }),
  };
  return decodeSharedSessionCatalogProjection(shared);
}

function projectCatalogLiveRunState(
  runningTurnIds: readonly string[],
): SessionCatalogLiveRunState | undefined {
  const uniqueRunningTurnIds = [...new Set(runningTurnIds)];
  if (uniqueRunningTurnIds.length > SESSION_CATALOG_RUNNING_TURN_MAX_ITEMS) return undefined;
  return {
    schemaVersion: SESSION_CATALOG_LIVE_RUN_STATE_SCHEMA_VERSION,
    runningTurnIds: uniqueRunningTurnIds,
  };
}

function projectCatalogLabels(labels: readonly string[]): {
  readonly labels: readonly string[];
  readonly truncated: boolean;
} {
  const projected: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const label of labels) {
    if (
      projected.length >= SESSION_CATALOG_LABEL_MAX_ITEMS ||
      label.length === 0 ||
      Buffer.byteLength(label, 'utf8') > SESSION_CATALOG_LABEL_MAX_BYTES ||
      label.trim() !== label ||
      /[\u0000-\u001f\u007f]/.test(label) ||
      seen.has(label)
    ) {
      truncated = true;
      continue;
    }
    projected.push(label);
    seen.add(label);
  }
  return { labels: projected, truncated };
}

function page(
  records: readonly SessionCatalogRecord[],
  revision: SessionCatalogRevision,
  hasMore: boolean,
  project: (record: SessionCatalogRecord) => SessionCatalogItem = projectSessionCatalogRecord,
): SessionCatalogQueryResult {
  const items: SessionCatalogItem[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) throw new Error('Session catalog record index is invalid');
    const item = project(record);
    const moreItems = index + 1 < records.length || hasMore;
    const candidate = {
      kind: 'page' as const,
      revision,
      sessions: [...items, item],
      nextCursor: moreItems ? encodeCursor(record) : null,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > SESSION_CATALOG_RESULT_MAX_BYTES) {
      break;
    }
    items.push(item);
  }
  if (items.length === 0 && records.length > 0) {
    throw new Error('A Session catalog projection exceeds the page byte limit');
  }
  const lastRecord = items.length === 0 ? undefined : records[items.length - 1];
  const moreItems = items.length < records.length || hasMore;
  return {
    kind: 'page',
    revision,
    sessions: items,
    nextCursor: moreItems && lastRecord ? encodeCursor(lastRecord) : null,
  };
}

function encodeCursor(record: SessionCatalogRecord): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      activityAt: record.activityAt,
      sessionId: record.header.id,
    }),
    'utf8',
  ).toString('base64url');
}

type DecodedSessionCatalogCursor = SessionCatalogPageCursor;

function decodeCursor(cursor: string): DecodedSessionCatalogCursor | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) return undefined;
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'activityAt,sessionId,version'
    ) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      !Number.isSafeInteger(record.activityAt) ||
      (record.activityAt as number) < 0 ||
      typeof record.sessionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(record.sessionId)
    ) {
      return undefined;
    }
    return {
      activityAt: record.activityAt as number,
      sessionId: record.sessionId,
    };
  } catch {
    return undefined;
  }
}

function normalizedSessionName(name: string): string {
  const normalized = normalizeUserSessionName(name);
  if (!normalized.ok) throw new SessionOperationFailure('invalid_request', normalized.error);
  return normalized.value;
}

function normalizeSessionNamePatch(name: string): Pick<SessionHeader, 'name' | 'titleIsManual'> {
  return { name: normalizedSessionName(name), titleIsManual: true };
}

/**
 * The caller already holds the admitted snapshot: re-reading it here would cost
 * a second identical read inside one lease.
 */
function replaceUserLabels(
  current: SessionHeaderSnapshot,
  expectedRevision: number,
  requestedLabels: readonly string[],
): string[] {
  if (current.revision !== expectedRevision) {
    throw new SessionMetadataVersionConflictError(
      current.header.id,
      expectedRevision,
      current.revision,
    );
  }
  return replaceUserOwnedLabels(current.header.labels, requestedLabels);
}

function replaceUserOwnedLabels(
  currentLabels: readonly string[],
  requestedLabels: readonly string[],
): string[] {
  const userLabels = requestedLabels.filter((label) => !isExecutionSemanticLabel(label));
  const labels: string[] = [];
  let userIndex = 0;
  for (const label of currentLabels) {
    if (isExecutionSemanticLabel(label)) {
      labels.push(label);
    } else if (userIndex < userLabels.length) {
      labels.push(userLabels[userIndex++]!);
    }
  }
  labels.push(...userLabels.slice(userIndex));
  return labels;
}

function revisionConflict(expectedRevision: number, actualRevision: number): SessionUpdateResult {
  return { kind: 'revision_conflict', expectedRevision, actualRevision };
}

function isNotFound(error: unknown): boolean {
  return isSessionNotFoundError(error);
}

function successQuery(
  result: SessionCatalogQueryResult,
): OperationOutcome<'session.catalog.query'> {
  return { ok: true, result };
}

function createSuccess(result: SessionCatalogItem): OperationOutcome<'session.create'> {
  return { ok: true, result };
}

function updateSuccess(result: SessionUpdateResult): OperationOutcome<'session.metadata.update'> {
  return { ok: true, result };
}

function configurationSuccess(
  result: SessionUpdateResult,
): OperationOutcome<'session.configuration.update'> {
  return { ok: true, result };
}

function workspaceSuccess(
  result: SessionUpdateResult,
): OperationOutcome<'session.workspace.relocate'> {
  return { ok: true, result };
}

function createFailure(
  code: OperationError<'session.create'>['code'],
  message: string,
): Extract<OperationOutcome<'session.create'>, { readonly ok: false }> {
  return { ok: false, error: { code, message } };
}

function queryFailure(
  code: OperationError<'session.catalog.query'>['code'],
  message: string,
): Extract<OperationOutcome<'session.catalog.query'>, { readonly ok: false }> {
  return { ok: false, error: { code, message } };
}

function executionBoundaryFailure(
  code: OperationError<'session.execution_boundary.query'>['code'],
  message: string,
): Extract<OperationOutcome<'session.execution_boundary.query'>, { readonly ok: false }> {
  return { ok: false, error: { code, message } };
}

function turnsFailure(
  code: OperationError<'session.turns.query'>['code'],
  message: string,
): Extract<OperationOutcome<'session.turns.query'>, { readonly ok: false }> {
  return { ok: false, error: { code, message } };
}

function turnLandmarksFailure(
  code: OperationError<'session.turn_landmarks.query'>['code'],
  message: string,
): Extract<OperationOutcome<'session.turn_landmarks.query'>, { readonly ok: false }> {
  return { ok: false, error: { code, message } };
}

function projectExecutionBoundary(boundary: ExecutionBoundary): ExecutionBoundarySummary {
  if (boundary.kind !== 'managed') return { kind: boundary.kind, revision: boundary.revision };
  return {
    kind: 'managed',
    access: executionBoundaryDisplayMode(boundary) === 'explore' ? 'read_only' : 'writable',
    revision: boundary.revision,
  };
}

function metadataFailure(
  code: OperationError<'session.metadata.update'>['code'],
  message: string,
): Extract<OperationOutcome<'session.metadata.update'>, { readonly ok: false }> {
  return { ok: false, error: { code, message } };
}

function configurationFailure(
  code: OperationError<'session.configuration.update'>['code'],
  message: string,
): Extract<OperationOutcome<'session.configuration.update'>, { readonly ok: false }> {
  return { ok: false, error: { code, message } };
}

function workspaceFailure(
  code: OperationError<'session.workspace.relocate'>['code'],
  message: string,
): Extract<OperationOutcome<'session.workspace.relocate'>, { readonly ok: false }> {
  return { ok: false, error: { code, message } };
}

function readMarkerFailure(
  code: OperationError<'session.read_marker.set'>['code'],
  message: string,
): Extract<OperationOutcome<'session.read_marker.set'>, { readonly ok: false }> {
  return { ok: false, error: { code, message } };
}

function createOperationFailure(
  error: unknown,
  fallback: OperationError<'session.create'>['code'],
): Extract<OperationOutcome<'session.create'>, { readonly ok: false }> {
  if (error instanceof SessionOperationFailure) {
    return createFailure(error.code, error.message);
  }
  return createFailure(fallback, 'Session create request is invalid');
}
