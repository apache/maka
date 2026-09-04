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

import { createHash, randomUUID } from 'node:crypto';
import { isDeepResearchSession } from '@maka/core/deep-research';
import { SIDE_CONVERSATION_SESSION_LABEL } from '@maka/core/side-conversation';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import {
  isWorkHubCoordinationSessionId,
  isWorkHubCoordinationSessionTarget,
  sessionRevisionFamilyId,
  type SessionConversationCopy,
  type SessionHeader,
  type StoredMessage,
} from '@maka/core/session';
import {
  archivedToolResultContainsLinkedChildReferences,
  archivedToolResultContainsConversationOwnedReferences,
  cloneConversationRuntimeLedger,
  collectConversationCopyLinkedChildReferences,
  collectConversationCopySessionContextRefIds,
  collectConversationCopySessionFileRefs,
  createConversationCopySlice,
  prepareConversationRuntimeLedgerCopy,
  type ConversationCopySlice,
  type ConversationRuntimeLedgerCopyPlan,
} from '@maka/runtime/conversation-copy';
import { isArchivedToolResultPlaceholder } from '@maka/runtime/context-budget';
import type { AgentRunEvent } from '@maka/core/agent-run';
import {
  decodeModelProjectionTransition,
  MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
  type ModelProjectionTransition,
} from '@maka/core/model-projection-transition';
import { type SessionManager } from '@maka/runtime/session-manager';
import {
  authenticateInteractiveArtifactStoreWriter,
  type InteractiveArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import {
  authenticateExecutionStoresWriter,
  isSessionNotFoundError,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import {
  authenticateInteractiveSessionTodoWriter,
  type InteractiveSessionTodoWriter,
} from '@maka/storage/session-todo-authority';
import type { InteractiveContextOffloadWriter } from '@maka/storage/context-offload-store';
import type {
  OperationOutcome,
  SessionConversationCopyInput,
  SessionConversationCopyResult,
  SessionRevisionAbandonInput,
  SessionRevisionAbandonResult,
} from '../protocol/index.js';
import type {
  SessionRevisionOperationHandlerMap,
  SessionRevisionOperationKey,
} from './operation-dispatcher.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';
import { projectSessionCatalogRecord } from './session-catalog-coordinator.js';
import type { SessionContinuityCoordinator } from './session-continuity-coordinator.js';
import {
  agentGraphRevisionAdmissionSessionIds,
  prepareAgentGraphRevisionReferences,
} from './session-revision-graph-references.js';
import {
  conversationCopyCommitFailureDiagnostic,
  conversationCopyCommitFailureMessage,
} from './session-revision-diagnostics.js';
import { purgeSessionSidecars } from './session-sidecar-purge.js';

type ConversationCopyKind = 'branch' | 'revision';
type ConversationCopySemanticKind = ConversationCopyKind | 'side_conversation';
type ConversationCopyOperationKey = Exclude<
  SessionRevisionOperationKey,
  'session.revision.abandon'
>;
type ConversationCopyOutcome = OperationOutcome<ConversationCopyOperationKey>;
type RevisionAbandonOutcome = OperationOutcome<'session.revision.abandon'>;
const CONVERSATION_COPY_ADMISSION_PASSES = 2;
interface ConversationCopyAdmissionRetry {
  readonly kind: 'retry_admission';
  readonly sessionIds: readonly string[];
}
type ConversationCopyCreateInput = CreateSessionInput & {
  readonly conversationCopy: SessionConversationCopy;
};

export interface HostSessionRevisionCoordinatorOptions {
  readonly stores: ExecutionStoresWriter<'interactive'>;
  readonly artifacts: InteractiveArtifactStoreWriter;
  readonly sessionTodo: InteractiveSessionTodoWriter;
  readonly contextOffload?: Pick<
    InteractiveContextOffloadWriter,
    'copyReferences' | 'retireSession' | 'collectGarbage'
  >;
  readonly manager: SessionManager;
  readonly admission: SessionAdmissionGate;
  readonly continuity: SessionContinuityCoordinator;
  readonly graph: Pick<
    import('@maka/runtime/stream-graph-coordinator').AgentGraphCoordinator,
    'readGraphState' | 'readSessionState'
  >;
  readonly isSessionActive: (sessionId: string) => boolean;
  readonly requestDrain: () => void;
}

/** Host authority for exact, retryable cross-Session branch and revision copies. */
export class HostSessionRevisionCoordinator {
  readonly handlers: SessionRevisionOperationHandlerMap = {
    'session.branch.create': (input) => this.#copy('branch', input),
    'session.revision.create': (input) => this.#copy('revision', input),
    'session.revision.abandon': (input) => this.#abandonRevision(input),
  };

  readonly #stores: ExecutionStoresWriter<'interactive'>;
  readonly #artifacts: InteractiveArtifactStoreWriter;
  readonly #sessionTodo: InteractiveSessionTodoWriter;

  constructor(private readonly options: HostSessionRevisionCoordinatorOptions) {
    this.#stores = authenticateExecutionStoresWriter(options.stores, 'interactive');
    this.#artifacts = authenticateInteractiveArtifactStoreWriter(options.artifacts);
    this.#sessionTodo = authenticateInteractiveSessionTodoWriter(options.sessionTodo);
  }

  async recover(): Promise<void> {
    const copies = (await this.#stores.sessionStore.listHeaders()).filter(
      (header) => header.conversationCopy !== undefined,
    );
    for (const header of copies) {
      if (header.conversationCopy!.state === 'preparing') await this.#discardDuringRecovery(header);
    }

    const committed = copies.filter((header) => header.conversationCopy!.state === 'committed');
    const retained = new Set(
      committed
        .filter(
          (header) =>
            header.conversationCopy!.kind === 'branch' || header.revisionState === 'committed',
        )
        .map((header) => header.id),
    );
    for (const header of committed) {
      if (
        header.conversationCopy!.kind === 'revision' &&
        header.revisionState === 'preparing' &&
        (await this.#hasAdmittedRevisionTurn(header.id))
      ) {
        retained.add(header.id);
      }
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const header of committed) {
        if (!retained.has(header.id)) continue;
        const sourceSessionId = header.conversationCopy!.sourceSessionId;
        if (!retained.has(sourceSessionId)) {
          retained.add(sourceSessionId);
          changed = true;
        }
      }
    }
    for (const header of committed) {
      if (header.conversationCopy!.kind !== 'revision' || header.revisionState !== 'preparing') {
        continue;
      }
      if (retained.has(header.id)) {
        await this.options.manager.commitRevisionVersion(header.id);
      } else {
        await this.#discardDuringRecovery(header);
      }
    }
  }

  async #discardDuringRecovery(header: SessionHeader): Promise<void> {
    try {
      await this.#discard(header);
    } catch (error) {
      console.error(
        `[runtime-host] conversation copy cleanup deferred during recovery (${header.id}): ${conversationCopyCommitFailureDiagnostic(error)}`,
      );
    }
  }

  async #copy(
    kind: ConversationCopyKind,
    input: SessionConversationCopyInput,
  ): Promise<ConversationCopyOutcome> {
    if (isWorkHubCoordinationSessionId(input.targetSessionId)) {
      return copyFailure(
        'operation_conflict',
        'Target Session identity is reserved for WorkHub coordination',
      );
    }
    if (isWorkHubCoordinationSessionId(input.sourceSessionId)) {
      return copyFailure(
        'operation_conflict',
        'WorkHub Coordination Session cannot be copied as an ordinary conversation',
      );
    }
    const semanticKind = conversationCopySemanticKind(kind, input);
    const requestFingerprint = conversationCopyFingerprint(semanticKind, input);
    const retry = await this.options.admission.run(input.targetSessionId, async () =>
      this.#resolveExistingTarget(semanticKind, input, requestFingerprint, true),
    );
    if (retry) return retry;

    let rootSessionId: string;
    try {
      const source = await this.#stores.sessionStore.readHeaderRecordSnapshot(
        input.sourceSessionId,
      );
      rootSessionId = source.header.revisionRootSessionId ?? input.sourceSessionId;
    } catch (error) {
      return isSessionNotFoundError(error)
        ? copyFailure('not_found', 'Source Session does not exist')
        : copyFailure('persistence_failed', 'Source Session metadata is unavailable');
    }

    const admittedSessionIds = new Set([
      input.sourceSessionId,
      input.targetSessionId,
      rootSessionId,
    ]);
    // The first admitted read discovers only children retained by this copy.
    // Artifact deletion uses each child Session lane, so retry with those exact
    // lanes and keep the complete lease through validation and publication.
    for (let pass = 0; pass < CONVERSATION_COPY_ADMISSION_PASSES; pass += 1) {
      const result = await this.options.admission.runMany([...admittedSessionIds], (lease) =>
        this.#copyAdmitted(semanticKind, input, requestFingerprint, lease, admittedSessionIds),
      );
      if ('ok' in result) return result;
      for (const sessionId of result.sessionIds) admittedSessionIds.add(sessionId);
    }
    return copyFailure('session_busy', 'Agent Graph child ownership changed during copy');
  }

  async #abandonRevision(input: SessionRevisionAbandonInput): Promise<RevisionAbandonOutcome> {
    return this.options.admission.run(input.targetSessionId, async () => {
      let header: SessionHeader;
      try {
        header = await this.#stores.sessionStore.readHeaderSnapshot(input.targetSessionId);
      } catch (error) {
        return isSessionNotFoundError(error)
          ? abandonFailure('not_found', 'Target Session revision does not exist')
          : abandonFailure('persistence_failed', 'Target Session revision is unavailable');
      }
      if (header.conversationCopy?.kind !== 'revision') {
        return abandonFailure('operation_conflict', 'Target is not a Session revision copy');
      }
      if (
        header.revisionState !== 'preparing' ||
        this.options.isSessionActive(input.targetSessionId) ||
        (await this.#hasAdmittedRevisionTurn(input.targetSessionId)) ||
        (await this.#hasCommittedConversationCopyDependent(input.targetSessionId))
      ) {
        return abandonSuccess({ kind: 'retained', sessionId: input.targetSessionId });
      }
      try {
        await this.#discard(header);
        return abandonSuccess({
          kind: 'abandoned',
          sessionId: input.targetSessionId,
        });
      } catch {
        return abandonFailure(
          'persistence_failed',
          'Target Session revision could not be abandoned',
        );
      }
    });
  }

  async #copyAdmitted(
    kind: ConversationCopySemanticKind,
    input: SessionConversationCopyInput,
    requestFingerprint: `sha256:${string}`,
    lease: SessionAdmissionLease,
    admittedSessionIds: ReadonlySet<string>,
  ): Promise<ConversationCopyOutcome | ConversationCopyAdmissionRetry> {
    const existing = await this.#resolveExistingTarget(kind, input, requestFingerprint, false);
    if (existing) return existing;

    let sourceRecord;
    try {
      sourceRecord = await this.#stores.sessionStore.readHeaderRecordSnapshot(
        input.sourceSessionId,
      );
    } catch (error) {
      return isSessionNotFoundError(error)
        ? copyFailure('not_found', 'Source Session does not exist')
        : copyFailure('persistence_failed', 'Source Session metadata is unavailable');
    }
    if (sourceRecord.revision !== input.expectedSourceRevision) {
      return copySuccess({
        kind: 'source_revision_conflict',
        expectedRevision: input.expectedSourceRevision,
        actualRevision: sourceRecord.revision,
      });
    }
    const sourceHeader = sourceRecord.header;
    if (sourceHeader.conversationCopy?.state === 'preparing') {
      return copyFailure('not_found', 'Source Session does not exist');
    }
    if (kind === 'revision' && sourceHeader.isArchived) {
      return copyFailure(
        'operation_conflict',
        'Archived Session revision families cannot create active revisions',
      );
    }
    if (isWorkHubCoordinationSessionTarget(sourceHeader)) {
      return copyFailure(
        'operation_conflict',
        'WorkHub Coordination Session cannot be copied as an ordinary conversation',
      );
    }
    if (sourceHeader.subagentParent) {
      return copyFailure(
        'operation_conflict',
        'Linked child Sessions cannot be copied as ordinary conversations',
      );
    }
    if (isDeepResearchSession(sourceHeader.labels)) {
      return copyFailure(
        'operation_unavailable',
        'Deep Research Sessions cannot be copied without an exact research ledger boundary',
      );
    }
    if (kind !== 'side_conversation' && this.options.isSessionActive(input.sourceSessionId)) {
      return copyFailure('session_busy', 'Source Session has an active Turn');
    }

    let source;
    try {
      source = await this.options.manager.readConversationCopySnapshot(input.sourceSessionId);
    } catch {
      return copyFailure('persistence_failed', 'Source conversation ledger is unavailable');
    }
    // An empty copy carries no source transcript: skip the slice so a side
    // conversation can fork before the source has any settled turn.
    let slice: ConversationCopySlice;
    if (input.sourceTurnId === undefined) {
      slice = { messages: [], turnIds: [] };
    } else {
      const throughSlice = createConversationCopySlice(
        source.messages,
        input.sourceTurnId,
        kind === 'revision' ? 'before' : 'through',
      );
      if (!throughSlice) {
        return copyFailure('invalid_request', 'Source turn does not exist');
      }
      slice = throughSlice;
    }
    let plan: ConversationRuntimeLedgerCopyPlan;
    let sessionHeaders: SessionHeader[];
    try {
      [plan, sessionHeaders] = await Promise.all([
        prepareConversationRuntimeLedgerCopy({
          sourceSessionId: input.sourceSessionId,
          sourceEvents: source.events,
          copiedMessages: slice.messages,
          runStore: this.#stores.agentRunStore,
          runtimeEventStore: this.#stores.runtimeEventStore,
        }),
        this.#stores.sessionStore.listHeaders(),
      ]);
    } catch (error) {
      if (isConversationRuntimeFactRewriteUnsupported(error)) {
        return copyFailure(
          'operation_unavailable',
          'Session conversation copy does not yet support continuation authority facts',
        );
      }
      return copyFailure('persistence_failed', 'Source conversation lineage is unavailable');
    }
    if (
      kind === 'revision' &&
      sessionHeaders.some(
        (candidate) =>
          sessionRevisionFamilyId(candidate) === sessionRevisionFamilyId(sourceHeader) &&
          candidate.isArchived,
      )
    ) {
      return copyFailure(
        'operation_conflict',
        'Archived Session revision families cannot create active revisions',
      );
    }
    const copyTurnIds = plan.copyTurnIds;
    const archivePreflight = await this.#readArchivedToolResults(
      input.sourceSessionId,
      plan.runs.flatMap(({ runtimeEvents }) => runtimeEvents),
      slice.messages,
      copyTurnIds,
      plan.runs.flatMap(({ operationalEvents }) => operationalEvents),
    );
    if (!archivePreflight.ok) return archivePreflight.outcome;
    const linkedChildRequests = collectConversationCopyLinkedChildReferences({
      messages: slice.messages,
      runtimeEvents: plan.runs.flatMap(({ runtimeEvents }) => runtimeEvents),
      archivedResults: archivePreflight.serializedResults,
    });
    const referencedSessionFileIds = collectConversationCopySessionFileRefs({
      sourceSessionId: input.sourceSessionId,
      messages: slice.messages,
      runtimeEvents: plan.runs.flatMap(({ runtimeEvents }) => runtimeEvents),
      archivedResults: archivePreflight.serializedResults,
    });
    const missingGraphChildSessionIds = agentGraphRevisionAdmissionSessionIds({
      sourceSessionId: input.sourceSessionId,
      sessionHeaders,
      copyTurnIds,
      requests: linkedChildRequests,
    }).filter((sessionId) => !admittedSessionIds.has(sessionId));
    if (missingGraphChildSessionIds.length > 0) {
      return { kind: 'retry_admission', sessionIds: missingGraphChildSessionIds };
    }
    const linkedReferences = await prepareAgentGraphRevisionReferences(
      {
        kind,
        sourceSessionId: input.sourceSessionId,
        sourceHeader,
        sessionHeaders,
        copyTurnIds,
        requests: linkedChildRequests,
      },
      {
        agentRunStore: this.#stores.agentRunStore,
        artifacts: this.#artifacts,
        graph: this.options.graph,
        isSessionActive: this.options.isSessionActive,
      },
    );
    if (!linkedReferences.ok) {
      return copyFailure(linkedReferences.code, linkedReferences.message);
    }
    if (
      kind !== 'side_conversation' &&
      archivePreflight.serializedResults.some((serializedResult) =>
        archivedToolResultContainsConversationOwnedReferences(
          serializedResult,
          input.sourceSessionId,
          linkedReferences.references,
        ),
      )
    ) {
      return copyFailure(
        'operation_unavailable',
        'Session conversation copy cannot preserve owned references inside archived tool results',
      );
    }

    let createInput: ConversationCopyCreateInput;
    try {
      createInput = await this.#createInput(kind, input, requestFingerprint, sourceHeader);
    } catch {
      return copyFailure('persistence_failed', 'Session revision family is unavailable');
    }
    let boundary;
    try {
      boundary = await this.#stores.sessionStore.readExecutionBoundary(input.sourceSessionId);
    } catch {
      return copyFailure('persistence_failed', 'Source execution boundary is unavailable');
    }

    const created = await this.#stores.sessionStore
      .createStableSession(
        {
          sessionId: input.targetSessionId,
          requestFingerprint,
          input: createInput,
        },
        boundary,
      )
      .catch(() => null);
    if (!created) {
      return this.#unknownAfterCommitAttempt(
        kind,
        input,
        requestFingerprint,
        'Session conversation-copy creation outcome is unknown',
      );
    }
    if (created.kind === 'conflict') {
      return copyFailure(
        'operation_conflict',
        'Target Session identity belongs to a different request',
      );
    }
    if (created.kind === 'existing') {
      return (
        (await this.#resolveExistingTarget(kind, input, requestFingerprint, false)) ??
        copyFailure('commit_outcome_unknown', 'Target Session publication state is unknown')
      );
    }

    try {
      const archivedSnapshotResults = new Map(
        archivePreflight.results
          .filter(
            ({ serializedResult }) =>
              archivedToolResultContainsLinkedChildReferences(serializedResult) ||
              archivedToolResultContainsConversationOwnedReferences(
                serializedResult,
                input.sourceSessionId,
                linkedReferences.references,
              ),
          )
          .map(({ descriptor, serializedResult }) => [descriptor.artifactId, serializedResult]),
      );
      const sourceContextRefIds = collectConversationCopySessionContextRefIds({
        sourceSessionId: input.sourceSessionId,
        messages: slice.messages,
        runtimeEvents: plan.runs.flatMap(({ runtimeEvents }) => runtimeEvents),
        archivedResults: archivePreflight.serializedResults,
      });
      if (sourceContextRefIds.length > 0 && !this.options.contextOffload) {
        throw new Error('Session context copy authority is unavailable');
      }
      const contextCopy =
        sourceContextRefIds.length === 0
          ? { ok: true as const, copied: [] }
          : await this.options.contextOffload!.copyReferences({
              sourceSessionId: input.sourceSessionId,
              targetSessionId: input.targetSessionId,
              references: sourceContextRefIds.map((sourceRefId) => ({
                sourceRefId,
                targetOwner: { kind: 'read_image_snapshot', ownerId: sourceRefId },
              })),
            });
      if (!contextCopy.ok) {
        throw new Error(`Session context references could not be copied: ${contextCopy.reason}`);
      }
      const artifactCopy = await this.#artifacts.copyConversationArtifacts({
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        turnIds: copyTurnIds,
        ...(referencedSessionFileIds.size > 0
          ? { includeArtifactIds: [...referencedSessionFileIds] }
          : {}),
        ...(kind === 'side_conversation' && archivedSnapshotResults.size > 0
          ? { excludeArtifactIds: [...archivedSnapshotResults.keys()] }
          : {}),
        ...(kind === 'side_conversation' && linkedReferences.references.size > 0
          ? {
              linkedArtifacts: [...linkedReferences.references].map(([sessionId, references]) => ({
                sessionId,
                artifactIds: [...references.artifactIds],
              })),
            }
          : {}),
      });
      const references = {
        mode: 'exact' as const,
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        artifactIds: artifactCopy.artifactIds,
        relativePaths: artifactCopy.relativePaths,
        contextRefs: new Map(
          contextCopy.copied.map(({ sourceRefId, targetRefId }) => [sourceRefId, targetRefId]),
        ),
        linkedChildren:
          kind === 'side_conversation'
            ? {
                mode: 'snapshot' as const,
                archivedResults: archivedSnapshotResults,
              }
            : linkedReferences.references.size > 0
              ? {
                  mode: 'preserve_validated' as const,
                  references: linkedReferences.references,
                }
              : { mode: 'reject' as const },
      };
      const runtimeCopy = await cloneConversationRuntimeLedger({
        plan,
        copiedMessages: slice.messages,
        referenceMap: references,
        runStore: this.#stores.agentRunStore,
        runtimeEventStore: this.#stores.runtimeEventStore,
        newId: randomUUID,
      });
      const copiedMessages = runtimeCopy.copiedMessages;
      await this.#sessionTodo.initializeCopy({
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        // An empty copy carries no source state, including no in-progress Todo.
        copyCurrent:
          kind === 'branch' && slice.beforeTs === undefined && input.sourceTurnId !== undefined,
      });
      if (copiedMessages.length > 0) {
        await this.#stores.sessionStore.appendMessages(input.targetSessionId, [...copiedMessages]);
      }
      await this.#stores.sessionStore.appendMessage(
        input.targetSessionId,
        conversationCopyStartNote(kind, input, createInput),
      );
      await this.#stores.sessionStore.updateHeader(input.targetSessionId, {
        conversationCopy: {
          ...createInput.conversationCopy!,
          state: 'committed',
        },
        isFlagged: sourceHeader.isFlagged,
        titleIsManual: sourceHeader.titleIsManual,
        connectionLocked:
          sourceHeader.connectionLocked ||
          copiedMessages.some((message) => message.type === 'user'),
      });
      await this.options.continuity.refreshCanonical(input.targetSessionId, lease);
      return copySuccess({
        kind: 'committed',
        session: projectSessionCatalogRecord(
          await this.#stores.sessionStore.readCatalogRecord(input.targetSessionId),
        ),
      });
    } catch (error) {
      console.error(
        `[runtime-host] ${kind} conversation copy commit failed (${input.sourceSessionId} -> ${input.targetSessionId}): ${conversationCopyCommitFailureDiagnostic(error)}`,
      );
      return this.#rollbackIncompleteCopy(
        kind,
        input,
        requestFingerprint,
        conversationCopyCommitFailureMessage(error),
      );
    }
  }

  async #readArchivedToolResults(
    sourceSessionId: string,
    sourceEvents: readonly RuntimeEvent[],
    copiedMessages: readonly StoredMessage[],
    copyTurnIds: readonly string[],
    operationalEvents: readonly AgentRunEvent[],
  ): Promise<
    | {
        readonly ok: true;
        readonly results: readonly {
          readonly descriptor: ArchivedToolResultCopyDescriptor;
          readonly serializedResult: string;
        }[];
        readonly serializedResults: readonly string[];
      }
    | { readonly ok: false; readonly outcome: ConversationCopyOutcome }
  > {
    const archives = collectArchivedToolResultPlaceholders(
      sourceEvents,
      copiedMessages,
      copyTurnIds,
      operationalEvents,
    );
    if (!archives) {
      return {
        ok: false,
        outcome: copyFailure('persistence_failed', 'Archived tool result metadata is invalid'),
      };
    }
    const results: Array<{
      descriptor: ArchivedToolResultCopyDescriptor;
      serializedResult: string;
    }> = [];
    for (const archive of archives) {
      const read = await this.#artifacts
        .readTextInSession(sourceSessionId, archive.artifactId, {
          maxBytes: archive.originalBytes,
        })
        .catch(() => null);
      if (
        !read?.ok ||
        Buffer.byteLength(read.text, 'utf8') !== archive.originalBytes ||
        createHash('sha256').update(read.text).digest('hex') !== archive.bodySha256
      ) {
        return {
          ok: false,
          outcome: copyFailure(
            'persistence_failed',
            'Archived tool result is unavailable or corrupt',
          ),
        };
      }
      results.push({ descriptor: archive, serializedResult: read.text });
    }
    return {
      ok: true,
      results,
      serializedResults: results.map(({ serializedResult }) => serializedResult),
    };
  }

  async #createInput(
    kind: ConversationCopySemanticKind,
    input: SessionConversationCopyInput,
    requestFingerprint: `sha256:${string}`,
    source: SessionHeader,
  ): Promise<ConversationCopyCreateInput> {
    const common: ConversationCopyCreateInput = {
      cwd: source.cwd,
      ...(source.projectId !== undefined ? { projectId: source.projectId } : {}),
      ...(source.llmConnectionId === undefined ? {} : { llmConnectionId: source.llmConnectionId }),
      llmConnectionSlug: source.llmConnectionSlug,
      model: source.model,
      ...(source.thinkingLevel !== undefined ? { thinkingLevel: source.thinkingLevel } : {}),
      permissionMode: source.permissionMode,
      collaborationMode: source.collaborationMode ?? 'agent',
      orchestrationMode: source.orchestrationMode ?? 'default',
      name: source.name,
      labels:
        kind === 'side_conversation'
          ? [...new Set([...source.labels, SIDE_CONVERSATION_SESSION_LABEL])]
          : [...source.labels],
      conversationCopy: {
        kind: persistedConversationCopyKind(kind),
        sourceSessionId: input.sourceSessionId,
        ...(input.sourceTurnId === undefined ? {} : { sourceTurnId: input.sourceTurnId }),
        requestFingerprint,
        state: 'preparing',
        ...(kind === 'side_conversation' ? { intent: kind } : {}),
      },
      status: 'active',
    };
    if (kind !== 'revision') {
      // An empty copy records provenance but fabricates no branch turn.
      return {
        ...common,
        parentSessionId: input.sourceSessionId,
        ...(input.sourceTurnId === undefined ? {} : { branchOfTurnId: input.sourceTurnId }),
      };
    }
    // Revision copies always carry a turn boundary (enforced at decode).
    if (input.sourceTurnId === undefined) {
      throw new Error('Session revision copy requires a turn boundary');
    }
    const revisionOfTurnId = input.sourceTurnId;
    const revisionRootSessionId = source.revisionRootSessionId ?? input.sourceSessionId;
    const family = (await this.#stores.sessionStore.listHeaders()).filter(
      (candidate) =>
        candidate.conversationCopy?.state !== 'preparing' &&
        (candidate.id === revisionRootSessionId ||
          candidate.revisionRootSessionId === revisionRootSessionId),
    );
    const revisionIndex =
      Math.max(1, ...family.map((candidate) => candidate.revisionIndex ?? 1)) + 1;
    return {
      ...common,
      ...(source.parentSessionId ? { parentSessionId: source.parentSessionId } : {}),
      ...(source.branchOfTurnId ? { branchOfTurnId: source.branchOfTurnId } : {}),
      revisionRootSessionId,
      revisionParentSessionId: input.sourceSessionId,
      revisionOfTurnId,
      revisionIndex,
      revisionState: 'preparing',
    };
  }

  async #resolveExistingTarget(
    kind: ConversationCopySemanticKind,
    input: SessionConversationCopyInput,
    requestFingerprint: `sha256:${string}`,
    discardPreparing: boolean,
  ): Promise<ConversationCopyOutcome | null> {
    let probe;
    try {
      probe = await this.#stores.sessionStore.probeStableSessionCreate(
        input.targetSessionId,
        requestFingerprint,
      );
    } catch {
      return copyFailure('persistence_failed', 'Target Session identity is unavailable');
    }
    if (probe.kind === 'absent') return null;
    if (probe.kind === 'conflict') {
      return copyFailure(
        'operation_conflict',
        'Target Session identity belongs to a different request',
      );
    }
    const copy = probe.record.header.conversationCopy;
    if (
      copy?.kind !== persistedConversationCopyKind(kind) ||
      copy.intent !== (kind === 'side_conversation' ? kind : undefined) ||
      copy.sourceSessionId !== input.sourceSessionId ||
      copy.sourceTurnId !== input.sourceTurnId ||
      copy.requestFingerprint !== requestFingerprint
    ) {
      return copyFailure(
        'operation_conflict',
        'Target Session identity belongs to a different conversation copy',
      );
    }
    if (copy.state === 'committed') {
      try {
        return copySuccess({
          kind: 'committed',
          session: projectSessionCatalogRecord(
            await this.#stores.sessionStore.readCatalogRecord(input.targetSessionId),
          ),
        });
      } catch {
        return copyFailure(
          'commit_outcome_unknown',
          'Committed target Session projection is unavailable',
        );
      }
    }
    if (!discardPreparing) return null;
    try {
      await this.#discard(probe.record.header);
      return null;
    } catch {
      this.options.requestDrain();
      return copyFailure(
        'commit_outcome_unknown',
        'Incomplete target Session could not be recovered',
      );
    }
  }

  async #rollbackIncompleteCopy(
    kind: ConversationCopySemanticKind,
    input: SessionConversationCopyInput,
    requestFingerprint: `sha256:${string}`,
    message: string,
  ): Promise<ConversationCopyOutcome> {
    let header;
    try {
      header = await this.#stores.sessionStore.readHeaderSnapshot(input.targetSessionId);
      if (header.conversationCopy?.state === 'committed') {
        return copySuccess({
          kind: 'committed',
          session: projectSessionCatalogRecord(
            await this.#stores.sessionStore.readCatalogRecord(input.targetSessionId),
          ),
        });
      }
      await this.#discard(header);
      return copyFailure('persistence_failed', message);
    } catch {
      return this.#unknownAfterCommitAttempt(kind, input, requestFingerprint, message);
    }
  }

  async #unknownAfterCommitAttempt(
    kind: ConversationCopySemanticKind,
    input: SessionConversationCopyInput,
    requestFingerprint: `sha256:${string}`,
    message: string,
  ): Promise<ConversationCopyOutcome> {
    const resolved = await this.#resolveExistingTarget(kind, input, requestFingerprint, false);
    if (resolved?.ok) return resolved;
    this.options.requestDrain();
    return copyFailure('commit_outcome_unknown', message);
  }

  async #discard(header: SessionHeader): Promise<void> {
    const copy = header.conversationCopy;
    if (!copy) throw new Error('Session is not a conversation copy');
    await purgeSessionSidecars(
      {
        artifacts: this.#artifacts,
        sessionTodo: this.#sessionTodo,
        ...(this.options.contextOffload ? { contextOffload: this.options.contextOffload } : {}),
        purgeOperationalState: (sessionId) =>
          this.#stores.purgeConversationOperationalState(sessionId),
      },
      header.id,
    );
    await this.#stores.sessionStore.discardStableConversationCopy(
      header.id,
      copy.requestFingerprint,
    );
  }

  async #hasAdmittedRevisionTurn(sessionId: string): Promise<boolean> {
    if (
      (await this.#stores.agentRunStore.listRootTurnAdmissionsForRecovery(sessionId)).length > 0
    ) {
      return true;
    }
    const messages = await this.#stores.sessionStore.readMessagesForRecovery(sessionId);
    let boundary = -1;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      if (
        message.type === 'system_note' &&
        message.kind === 'session_start' &&
        isRevisionStartData(message.data)
      ) {
        boundary = index;
      }
    }
    return boundary >= 0 && messages.slice(boundary + 1).some((message) => message.type === 'user');
  }

  async #hasCommittedConversationCopyDependent(sessionId: string): Promise<boolean> {
    return (await this.#stores.sessionStore.listHeaders()).some(
      (header) =>
        header.conversationCopy?.state === 'committed' &&
        header.conversationCopy.sourceSessionId === sessionId,
    );
  }
}

function isConversationRuntimeFactRewriteUnsupported(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'branch_runtime_fact_rewrite_unsupported'
  );
}

function conversationCopyFingerprint(
  kind: ConversationCopySemanticKind,
  input: SessionConversationCopyInput,
): `sha256:${string}` {
  // The optimistic source revision guards only the initial create. Once this
  // target exists, its stable identity must resolve the committed outcome even
  // if a reconnecting Client observes a newer source revision.
  const identity = [
    kind === 'side_conversation' ? 'session.conversation-copy.v2' : 'session.conversation-copy.v1',
    kind,
    input.sourceSessionId,
    input.targetSessionId,
    // Absent for an empty copy. JSON.stringify renders the missing element as
    // null, so an empty copy gets a distinct identity while through_turn and
    // revision hashes stay byte-identical to a required sourceTurnId.
    input.sourceTurnId,
  ];
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

function conversationCopyStartNote(
  kind: ConversationCopySemanticKind,
  input: SessionConversationCopyInput,
  createInput: ConversationCopyCreateInput,
): StoredMessage {
  const base = {
    type: 'system_note' as const,
    id: randomUUID(),
    ts: Date.now(),
    kind: 'session_start' as const,
  };
  if (kind !== 'revision') {
    // Empty copies record provenance without a branch turn.
    return {
      ...base,
      data: {
        parentSessionId: input.sourceSessionId,
        ...(input.sourceTurnId === undefined ? {} : { branchOfTurnId: input.sourceTurnId }),
      },
    };
  }
  if (input.sourceTurnId === undefined) {
    throw new Error('Session revision copy requires a turn boundary');
  }
  return {
    ...base,
    data: {
      revisionRootSessionId: createInput.revisionRootSessionId,
      revisionParentSessionId: input.sourceSessionId,
      revisionOfTurnId: input.sourceTurnId,
      revisionIndex: createInput.revisionIndex,
      revisionState: 'preparing',
    },
  };
}

function conversationCopySemanticKind(
  kind: ConversationCopyKind,
  input: SessionConversationCopyInput,
): ConversationCopySemanticKind {
  return kind === 'branch' && input.intent === 'side_conversation' ? input.intent : kind;
}

function persistedConversationCopyKind(kind: ConversationCopySemanticKind): ConversationCopyKind {
  return kind === 'revision' ? 'revision' : 'branch';
}

function isRevisionStartData(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'revisionRootSessionId' in value
  );
}

function collectArchivedToolResultPlaceholders(
  events: readonly RuntimeEvent[],
  messages: readonly StoredMessage[],
  copyTurnIds: readonly string[],
  operationalEvents: readonly AgentRunEvent[],
): ArchivedToolResultCopyDescriptor[] | null {
  const retainedTurnIds = new Set(copyTurnIds);
  const archives = new Map<string, ArchivedToolResultCopyDescriptor>();
  const add = (value: unknown): boolean => {
    if (!isRecord(value) || value.kind !== 'maka.archived_tool_result') return true;
    if (!isArchivedToolResultPlaceholder(value)) return false;
    addDescriptor(value);
    return true;
  };
  const addDescriptor = (descriptor: ArchivedToolResultCopyDescriptor): void => {
    const key = `${descriptor.artifactId}:${descriptor.bodySha256}:${descriptor.originalBytes}`;
    if (!archives.has(key)) archives.set(key, descriptor);
  };

  for (const event of events) {
    if (retainedTurnIds.has(event.turnId) && event.content?.kind === 'function_response') {
      if (!add(event.content.result)) return null;
    }
  }
  // A pruned result's body is now named by its durable transition rather than
  // by the RuntimeEvent, so the copy must reach the ledger to find it. Missing
  // this is not a cosmetic gap: the target Session would carry a placeholder
  // pointing at an artifact that was never copied.
  for (const event of operationalEvents) {
    if (event.type !== MODEL_PROJECTION_TRANSITION_EVENT_TYPE) continue;
    let transition: ModelProjectionTransition;
    try {
      transition = decodeModelProjectionTransition(event.data?.transition, event.sessionId);
    } catch {
      return null;
    }
    if (transition.replacement.kind !== 'json') return null;
    if (!add(transition.replacement.value)) return null;
  }
  for (const message of messages) {
    if (message.type !== 'tool_result') continue;
    if (message.content.kind === 'json') {
      if (!add(message.content.value)) return null;
      continue;
    }
    if (message.content.kind === 'archived_tool_result') {
      if (!message.content.artifactId && !message.content.bodySha256) continue;
      if (!message.content.artifactId || !message.content.bodySha256) return null;
      addDescriptor({
        artifactId: message.content.artifactId,
        bodySha256: message.content.bodySha256,
        originalBytes: message.content.originalBytes,
      });
    }
  }
  return [...archives.values()];
}

interface ArchivedToolResultCopyDescriptor {
  readonly artifactId: string;
  readonly bodySha256: string;
  readonly originalBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function copySuccess(result: SessionConversationCopyResult): ConversationCopyOutcome {
  return { ok: true, result };
}

function abandonSuccess(result: SessionRevisionAbandonResult): RevisionAbandonOutcome {
  return { ok: true, result };
}

function copyFailure(
  code: Extract<ConversationCopyOutcome, { ok: false }>['error']['code'],
  message: string,
): ConversationCopyOutcome {
  return { ok: false, error: { code, message } };
}

function abandonFailure(
  code: Extract<RevisionAbandonOutcome, { ok: false }>['error']['code'],
  message: string,
): RevisionAbandonOutcome {
  return { ok: false, error: { code, message } };
}
