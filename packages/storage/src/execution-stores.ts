import type {
  AgentRunEvent,
  AgentRunEventType,
  AgentRunHeader,
  RuntimeEvent,
  RuntimeContinuationAuthorityStore,
  SessionHeader,
  SessionListFilter,
  SessionSummary,
  StoredMessage,
  ToolBoundaryProtocol,
  TurnRecord,
} from '@maka/core';
import {
  createSqliteAgentRunStore,
  type AgentRunIdentitySearchResult,
  type AdmitRootTurnInput,
  type AdmitRootTurnResult,
  type BoundedEvidenceReadResult,
  type DurableAgentRunStore,
  type DurableRuntimeEventStore,
  type EvidenceReadBudget,
  type RootTurnAdmission,
  type RootTurnSourceMessageReceipt,
} from './agent-run-store.js';
import {
  createConversationOperationalStateStore,
  type ConversationOperationalStateStore,
} from './conversation-operational-state.js';
import {
  createSqliteMessageReceiptStore,
  type MessageReceiptStore,
} from './message-receipt-store.js';
import { createSessionStore, type SessionAuthorityStore } from './session-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootKind,
  type StorageRootLease,
} from './root-authority.js';
import {
  closeSqliteInteractionStoreFacade,
  openSqliteInteractiveInteractionStoreForRead,
  openSqliteInteractiveInteractionStoreForWrite,
  type InteractiveInteractionStoreReaderFacade,
  type InteractiveInteractionStoreWriterFacade,
} from './interaction-store.js';
import {
  openRuntimeEventPersistence,
  openRuntimeEventReadPersistence,
} from './runtime-event-persistence.js';
import type {
  CommitToolOutcomeInput,
  CommitToolPreparedInput,
  ToolCommitResult,
  ToolOperationRecord,
} from './sqlite-runtime-store.js';

const executionStoresWriterBrand: unique symbol = Symbol('ExecutionStoresWriter');
const executionStoresReaderBrand: unique symbol = Symbol('ExecutionStoresReader');
const executionStoresWriterKinds = new WeakMap<object, StorageRootKind>();
const executionStoresReaderKinds = new WeakMap<object, StorageRootKind>();
const executionStoresWritersByLease = new WeakMap<object, object>();
const executionStoresWritersOpeningByLease = new WeakMap<object, Promise<void>>();

export { normalizeRootTurnAdmissionPayload } from './agent-run-store.js';
export {
  isSessionNotFoundError,
  SessionReadMarkerMessageNotFoundError,
} from './session-store.js';
export {
  SessionMetadataConflictError,
  SessionMetadataVersionConflictError,
} from './sqlite-session-metadata-store.js';

export type {
  AgentRunIdentitySearchResult,
  AdmitRootTurnInput,
  AdmitRootTurnResult,
  BoundedEvidenceReadResult,
  EvidenceReadBudget,
  ImmutableSteeringMessageProof,
  RootTurnAdmission,
  RootTurnAdmissionStore,
  RootTurnSourceMessage,
  RootTurnSourceMessageReceipt,
} from './agent-run-store.js';
export type {
  MessageOperationReceipt,
  MessageReceiptOperation,
  MessageReceiptStore,
} from './message-receipt-store.js';
export type {
  ProbeSessionRemovalResult,
  SessionCatalogPageCursor,
  SessionCatalogPageResult,
  SessionCatalogRecord,
  SessionHeaderSnapshot,
} from './session-store.js';

export type ExecutionSessionWriter = SessionAuthorityStore;
export type ExecutionAgentRunWriter = DurableAgentRunStore;
export type ExecutionRuntimeEventWriter = DurableRuntimeEventStore &
  RuntimeContinuationAuthorityStore & {
    readonly toolBoundaryProtocol: ToolBoundaryProtocol;
    commitToolPrepared(input: CommitToolPreparedInput): Promise<ToolCommitResult>;
    commitToolOutcome(input: CommitToolOutcomeInput): Promise<ToolCommitResult>;
    listUnsettledToolOperations(sessionId: string): Promise<ToolOperationRecord[]>;
  };
export type ExecutionMessageReceiptWriter = MessageReceiptStore;

interface ExecutionStoresWriterBase<K extends StorageRootKind> {
  readonly kind: K;
  readonly [executionStoresWriterBrand]: K;
  purgeConversationOperationalState(sessionId: string): Promise<void>;
  readonly sessionStore: Readonly<ExecutionSessionWriter>;
  readonly agentRunStore: Readonly<ExecutionAgentRunWriter>;
  readonly runtimeEventStore: Readonly<ExecutionRuntimeEventWriter>;
  readonly messageReceiptStore: Readonly<ExecutionMessageReceiptWriter>;
}

export interface InteractiveExecutionStoresWriter extends ExecutionStoresWriterBase<'interactive'> {
  readonly interactionStore: InteractiveInteractionStoreWriterFacade;
}

export type HeadlessExecutionStoresWriter = ExecutionStoresWriterBase<'headless'>;

interface ExecutionStoresWriters {
  readonly interactive: InteractiveExecutionStoresWriter;
  readonly headless: HeadlessExecutionStoresWriter;
}

export type ExecutionStoresWriter<K extends StorageRootKind> = ExecutionStoresWriters[K];

export interface ExecutionSessionReader {
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
  close?(): Promise<void>;
}

export interface ExecutionAgentRunReader {
  readRun(sessionId: string, runId: string): Promise<AgentRunHeader>;
  findRunsById(runId: string, limit: number): Promise<AgentRunIdentitySearchResult>;
  listSessionRuns(sessionId: string): Promise<AgentRunHeader[]>;
  listSessionRunsBounded(sessionId: string, limit: number): Promise<AgentRunIdentitySearchResult>;
  readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
  readEventsBounded(
    sessionId: string,
    runId: string,
    budget: EvidenceReadBudget,
  ): Promise<BoundedEvidenceReadResult<AgentRunEvent>>;
  readEventProjection(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined>;
  readRootTurnAdmission(sessionId: string, turnId: string): Promise<RootTurnAdmission | undefined>;
  readRootTurnSourceMessageReceipt(
    sessionId: string,
    sourceMessageId: string,
  ): Promise<RootTurnSourceMessageReceipt | undefined>;
}

export interface ExecutionRuntimeEventReader {
  readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readRuntimeEventsBounded(
    sessionId: string,
    runId: string,
    budget: EvidenceReadBudget,
  ): Promise<BoundedEvidenceReadResult<RuntimeEvent>>;
  readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]>;
}

interface ExecutionStoresReaderBase<K extends StorageRootKind> {
  readonly kind: K;
  readonly [executionStoresReaderBrand]: K;
  readonly sessionStore: Readonly<ExecutionSessionReader>;
  readonly agentRunStore: Readonly<ExecutionAgentRunReader>;
  readonly runtimeEventStore: Readonly<ExecutionRuntimeEventReader>;
}

export interface InteractiveExecutionStoresReader extends ExecutionStoresReaderBase<'interactive'> {
  readonly interactionStore: InteractiveInteractionStoreReaderFacade;
}

export type HeadlessExecutionStoresReader = ExecutionStoresReaderBase<'headless'>;

interface ExecutionStoresReaders {
  readonly interactive: InteractiveExecutionStoresReader;
  readonly headless: HeadlessExecutionStoresReader;
}

export type ExecutionStoresReader<K extends StorageRootKind> = ExecutionStoresReaders[K];

export function authenticateExecutionStoresWriter<K extends StorageRootKind>(
  stores: ExecutionStoresWriter<K>,
  expectedKind: K,
): ExecutionStoresWriter<K> {
  if (executionStoresWriterKinds.get(stores) !== expectedKind) {
    throw invalidExecutionStores(expectedKind, 'write');
  }
  return stores;
}

export function authenticateExecutionStoresReader<K extends StorageRootKind>(
  stores: ExecutionStoresReader<K>,
  expectedKind: K,
): ExecutionStoresReader<K> {
  if (executionStoresReaderKinds.get(stores) !== expectedKind) {
    throw invalidExecutionStores(expectedKind, 'read');
  }
  return stores;
}

export async function openInteractiveExecutionStoresForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<ExecutionStoresWriter<'interactive'>> {
  const interactionStore = await openSqliteInteractiveInteractionStoreForWrite(lease);
  return openExecutionStoresForWrite(lease, 'interactive', { interactionStore });
}

export async function openHeadlessExecutionStoresForWrite(
  lease: StorageRootLease<'headless', 'write'>,
): Promise<ExecutionStoresWriter<'headless'>> {
  return openExecutionStoresForWrite(lease, 'headless', {});
}

async function openExecutionStoresForWrite<K extends StorageRootKind, E extends object>(
  lease: StorageRootLease<K, 'write'>,
  kind: K,
  extension: E,
): Promise<ExecutionStoresWriterBase<K> & E> {
  await assertStorageRootLease(lease, kind, 'write');
  const existing = executionStoresWritersByLease.get(lease);
  if (existing) return existing as ExecutionStoresWriterBase<K> & E;

  const opening = executionStoresWritersOpeningByLease.get(lease);
  if (opening) {
    await opening;
    return openExecutionStoresForWrite(lease, kind, extension);
  }

  let releaseOpening!: () => void;
  const openingGate = new Promise<void>((resolve) => {
    releaseOpening = resolve;
  });
  executionStoresWritersOpeningByLease.set(lease, openingGate);
  try {
    return await createExecutionStoresForWrite(lease, kind, extension);
  } finally {
    executionStoresWritersOpeningByLease.delete(lease);
    releaseOpening();
  }
}

async function createExecutionStoresForWrite<K extends StorageRootKind, E extends object>(
  lease: StorageRootLease<K, 'write'>,
  kind: K,
  extension: E,
): Promise<ExecutionStoresWriterBase<K> & E> {
  const sessionStore = createSessionStore(lease.canonicalPath);
  const agentRunStore = createSqliteAgentRunStore(lease.canonicalPath);
  const interactionStore =
    'interactionStore' in extension
      ? (extension.interactionStore as InteractiveInteractionStoreWriterFacade)
      : undefined;
  const runtimePersistence = await openRuntimeEventPersistence({
    workspaceRoot: lease.canonicalPath,
  }).catch(async (error) => {
    await sessionStore.close?.().catch(() => {});
    agentRunStore.close?.();
    if (interactionStore) closeSqliteInteractionStoreFacade(interactionStore);
    throw error;
  });
  const runtimeEventStore = runtimePersistence.runtimeEventStore;
  let conversationOperationalStateStore: ConversationOperationalStateStore;
  try {
    conversationOperationalStateStore = createConversationOperationalStateStore(
      lease.canonicalPath,
    );
  } catch (error) {
    await closeExecutionStorePersistence(sessionStore, runtimePersistence, {
      agentRunStore,
      interactionStore,
    }).catch(() => {});
    throw error;
  }
  const messageReceiptStore = createSqliteMessageReceiptStore(lease.canonicalPath);
  await Promise.all([agentRunStore.ready?.(), messageReceiptStore.ready()]).catch(async (error) => {
    await closeExecutionStorePersistence(sessionStore, runtimePersistence, {
      agentRunStore,
      conversationOperationalStateStore,
      messageReceiptStore,
      interactionStore,
    }).catch(() => {});
    throw error;
  });
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, kind, 'write', operation);

  const stores: ExecutionStoresWriterBase<K> & E = {
    ...extension,
    kind,
    [executionStoresWriterBrand]: kind,
    purgeConversationOperationalState: (sessionId) =>
      run(() => conversationOperationalStateStore.purge(sessionId)),
    sessionStore: {
      create: (input, initialBoundary) => run(() => sessionStore.create(input, initialBoundary)),
      probeStableSessionCreate: (sessionId, requestFingerprint) =>
        run(() => sessionStore.probeStableSessionCreate(sessionId, requestFingerprint)),
      createStableSession: (request, initialBoundary) =>
        run(() => sessionStore.createStableSession(request, initialBoundary)),
      discardStableConversationCopy: (sessionId, requestFingerprint) =>
        run(() => sessionStore.discardStableConversationCopy(sessionId, requestFingerprint)),
      createSubagent: (input, initialBoundary) =>
        run(() => sessionStore.createSubagent(input, initialBoundary)),
      createAgentGraphOperator: (input, request, expectedRevision, initialBoundary) =>
        run(() =>
          sessionStore.createAgentGraphOperator(input, request, expectedRevision, initialBoundary),
        ),
      readExecutionBoundary: (sessionId) =>
        run(() => sessionStore.readExecutionBoundary(sessionId)),
      createSandboxBoundaryRequest: (input) =>
        run(() => sessionStore.createSandboxBoundaryRequest(input)),
      readSandboxBoundaryRequest: (sessionId, requestId) =>
        run(() => sessionStore.readSandboxBoundaryRequest(sessionId, requestId)),
      listPendingSandboxBoundaryRequests: (sessionId) =>
        run(() => sessionStore.listPendingSandboxBoundaryRequests(sessionId)),
      listSandboxBoundaryRestartClosures: (sessionId) =>
        run(() => sessionStore.listSandboxBoundaryRestartClosures(sessionId)),
      settleSandboxBoundaryRequest: (input) =>
        run(() => sessionStore.settleSandboxBoundaryRequest(input)),
      setExecutionBoundaryKind: (sessionId, boundaryKind, projection) =>
        run(() => sessionStore.setExecutionBoundaryKind(sessionId, boundaryKind, projection)),
      list: (filter) => run(() => sessionStore.list(filter)),
      listCatalogPage: (filter, cursor, limit, expectedRevision) =>
        run(() => sessionStore.listCatalogPage(filter, cursor, limit, expectedRevision)),
      listHeaders: () => run(() => sessionStore.listHeaders()),
      listSessionsWithUnresolvedProject: () =>
        run(() => sessionStore.listSessionsWithUnresolvedProject()),
      listForRecovery: () => run(() => sessionStore.listForRecovery()),
      readHeaderSnapshot: (sessionId) => run(() => sessionStore.readHeaderSnapshot(sessionId)),
      readHeaderRecordSnapshot: (sessionId) =>
        run(() => sessionStore.readHeaderRecordSnapshot(sessionId)),
      readCatalogRecord: (sessionId) => run(() => sessionStore.readCatalogRecord(sessionId)),
      probeSessionRemoval: (sessionId) => run(() => sessionStore.probeSessionRemoval(sessionId)),
      readMessagesSnapshot: (sessionId) => run(() => sessionStore.readMessagesSnapshot(sessionId)),
      readMessagesForRecovery: (sessionId) =>
        run(() => sessionStore.readMessagesForRecovery(sessionId)),
      listTurnsSnapshot: (sessionId) => run(() => sessionStore.listTurnsSnapshot(sessionId)),
      readHeader: (sessionId) => run(() => sessionStore.readHeader(sessionId)),
      readMessages: (sessionId) => run(() => sessionStore.readMessages(sessionId)),
      listTurns: (sessionId) => run(() => sessionStore.listTurns(sessionId)),
      appendMessage: (sessionId, message) =>
        run(() => sessionStore.appendMessage(sessionId, message)),
      appendMessages: (sessionId, messages) =>
        run(() => sessionStore.appendMessages(sessionId, messages)),
      updateHeader: (sessionId, patch) => run(() => sessionStore.updateHeader(sessionId, patch)),
      updateHeaderVersioned: (sessionId, patch, expectedRevision) =>
        run(() => sessionStore.updateHeaderVersioned(sessionId, patch, expectedRevision)),
      updateSessionConfiguration: (sessionId, input) =>
        run(() => sessionStore.updateSessionConfiguration(sessionId, input)),
      markSessionReadThroughMessage: (sessionId, messageId) =>
        run(() => sessionStore.markSessionReadThroughMessage(sessionId, messageId)),
      markSessionReadThrough: (sessionId, readThroughTs) =>
        run(() => sessionStore.markSessionReadThrough(sessionId, readThroughTs)),
      archive: (sessionId) => run(() => sessionStore.archive(sessionId)),
      unarchive: (sessionId) => run(() => sessionStore.unarchive(sessionId)),
      setFlagged: (sessionId, isFlagged) =>
        run(() => sessionStore.setFlagged(sessionId, isFlagged)),
      rename: (sessionId, name) => run(() => sessionStore.rename(sessionId, name)),
      setGeneratedTitleIfAbsent: (sessionId, title) =>
        run(() => sessionStore.setGeneratedTitleIfAbsent(sessionId, title)),
      remove: (sessionId) => run(() => sessionStore.remove(sessionId)),
      setSessionsLifecycleVersioned: (sessions, state) =>
        run(() => sessionStore.setSessionsLifecycleVersioned(sessions, state)),
      removeSessionsVersioned: (sessions) =>
        run(() => sessionStore.removeSessionsVersioned(sessions)),
      reconcileOrphanedAgentGraphRetirements: () =>
        run(() => sessionStore.reconcileOrphanedAgentGraphRetirements()),
      listPendingSessionRetirementCleanupIds: (sessionId) =>
        run(() => sessionStore.listPendingSessionRetirementCleanupIds(sessionId)),
      completeSessionRetirementCleanup: (sessionId) =>
        run(() => sessionStore.completeSessionRetirementCleanup(sessionId)),
      close: () =>
        closeExecutionStorePersistence(sessionStore, runtimePersistence, {
          agentRunStore,
          conversationOperationalStateStore,
          messageReceiptStore,
          interactionStore,
        }),
    },
    agentRunStore: {
      createRun: (header, options) => run(() => agentRunStore.createRun(header, options)),
      updateRun: (sessionId, runId, patch, options) =>
        run(() => agentRunStore.updateRun(sessionId, runId, patch, options)),
      readRun: (sessionId, runId) => run(() => agentRunStore.readRun(sessionId, runId)),
      findRunsById: (runId, limit) => run(() => agentRunStore.findRunsById(runId, limit)),
      listSessionRuns: (sessionId) => run(() => agentRunStore.listSessionRuns(sessionId)),
      listSessionRunsBounded: (sessionId, limit) =>
        run(() => agentRunStore.listSessionRunsBounded(sessionId, limit)),
      listSessionRunsForRecovery: (sessionId) =>
        run(() => agentRunStore.listSessionRunsForRecovery(sessionId)),
      appendEvent: (sessionId, runId, event, options) =>
        run(() => agentRunStore.appendEvent(sessionId, runId, event, options)),
      readEvents: (sessionId, runId) => run(() => agentRunStore.readEvents(sessionId, runId)),
      readEventsBounded: (sessionId, runId, budget) =>
        run(() => agentRunStore.readEventsBounded(sessionId, runId, budget)),
      readEventsForRecovery: (sessionId, runId) =>
        run(() => agentRunStore.readEventsForRecovery(sessionId, runId)),
      readEventsForEvidence: (sessionId, runId) =>
        run(() => agentRunStore.readEventsForEvidence(sessionId, runId)),
      readEventProjection: (sessionId, type) =>
        run(() => agentRunStore.readEventProjection(sessionId, type)),
      repairEventProjection: (sessionId, type, event, options) =>
        run(() => agentRunStore.repairEventProjection(sessionId, type, event, options)),
      admitRootTurn: (input: AdmitRootTurnInput): Promise<AdmitRootTurnResult> =>
        run(() => agentRunStore.admitRootTurn(input)),
      readRootTurnAdmission: (sessionId, turnId) =>
        run(() => agentRunStore.readRootTurnAdmission(sessionId, turnId)),
      readRootTurnSourceMessageReceipt: (sessionId, sourceMessageId) =>
        run(() => agentRunStore.readRootTurnSourceMessageReceipt(sessionId, sourceMessageId)),
      listRootTurnAdmissionsForRecovery: (sessionId) =>
        run(() => agentRunStore.listRootTurnAdmissionsForRecovery(sessionId)),
    },
    runtimeEventStore: {
      durability: runtimeEventStore.durability,
      continuationAuthorityCapability: runtimeEventStore.continuationAuthorityCapability,
      toolBoundaryProtocol: runtimePersistence.runtimeCommitStore.toolBoundaryProtocol,
      appendRuntimeEvent: (sessionId, runId, event, options) =>
        run(() => runtimeEventStore.appendRuntimeEvent(sessionId, runId, event, options)),
      appendRuntimePartialBatch: (sessionId, runId, events) =>
        run(() => runtimeEventStore.appendRuntimePartialBatch(sessionId, runId, events)),
      importConversationCopyRuntimeEvents: (sessionId, batches) =>
        run(() => runtimeEventStore.importConversationCopyRuntimeEvents(sessionId, batches)),
      ensureTerminalRuntimeEventDurable: (sessionId, runId, event) =>
        run(() => runtimeEventStore.ensureTerminalRuntimeEventDurable(sessionId, runId, event)),
      readRuntimeEvents: (sessionId, runId) =>
        run(() => runtimeEventStore.readRuntimeEvents(sessionId, runId)),
      readRuntimeEventsBounded: (sessionId, runId, budget) =>
        run(() => runtimeEventStore.readRuntimeEventsBounded(sessionId, runId, budget)),
      readImmutableRuntimeEvents: (sessionId, runId) =>
        run(() => runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId)),
      readImmutableRuntimePrefix: (input) =>
        run(() => runtimeEventStore.readImmutableRuntimePrefix(input)),
      readSessionRuntimeEvents: (sessionId) =>
        run(() => runtimeEventStore.readSessionRuntimeEvents(sessionId)),
      claimContinuation: (input) => run(() => runtimeEventStore.claimContinuation(input)),
      readContinuationClaimByBoundary: (boundaryDigest) =>
        run(() => runtimeEventStore.readContinuationClaimByBoundary(boundaryDigest)),
      readContinuationClaimStateByBoundary: (boundaryDigest) =>
        run(() => runtimeEventStore.readContinuationClaimStateByBoundary(boundaryDigest)),
      listContinuationClaimsForRecovery: (sessionId) =>
        run(() => runtimeEventStore.listContinuationClaimsForRecovery(sessionId)),
      commitContinuationStart: (input) =>
        run(() => runtimeEventStore.commitContinuationStart(input)),
      commitContinuationRepairStart: (input) =>
        run(() => runtimeEventStore.commitContinuationRepairStart(input)),
      readImmutableSteeringMessageProof: (sessionId, messageId) =>
        run(() => runtimeEventStore.readImmutableSteeringMessageProof(sessionId, messageId)),
      repairImmutableSteeringMessageProofsForRecovery: (sessionId) =>
        run(() => runtimeEventStore.repairImmutableSteeringMessageProofsForRecovery(sessionId)),
      commitToolPrepared: (input) =>
        run(() => runtimePersistence.runtimeCommitStore.commitToolPrepared(input)),
      commitToolOutcome: (input) =>
        run(() => runtimePersistence.runtimeCommitStore.commitToolOutcome(input)),
      listUnsettledToolOperations: (sessionId) =>
        run(() => runtimePersistence.runtimeCommitStore.listUnsettledToolOperations(sessionId)),
    },
    messageReceiptStore: {
      beginHostEpoch: (hostEpoch) => run(() => messageReceiptStore.beginHostEpoch(hostEpoch)),
      read: (hostEpoch, operation, sessionId, operationId) =>
        run(() => messageReceiptStore.read(hostEpoch, operation, sessionId, operationId)),
      commit: (hostEpoch, operation, sessionId, operationId, receipt) =>
        run(() =>
          messageReceiptStore.commit(hostEpoch, operation, sessionId, operationId, receipt),
        ),
    },
  };
  freezeExecutionStoresFacade(stores);
  executionStoresWriterKinds.set(stores, kind);
  executionStoresWritersByLease.set(lease, stores);
  return stores;
}

export async function openInteractiveExecutionStoresForRead(
  lease: StorageRootLease<'interactive', 'read'>,
): Promise<ExecutionStoresReader<'interactive'>> {
  const interactionStore = await openSqliteInteractiveInteractionStoreForRead(lease);
  return openExecutionStoresForRead(lease, 'interactive', { interactionStore });
}

export async function openHeadlessExecutionStoresForRead(
  lease: StorageRootLease<'headless', 'read'>,
): Promise<ExecutionStoresReader<'headless'>> {
  return openExecutionStoresForRead(lease, 'headless', {});
}

async function openExecutionStoresForRead<K extends StorageRootKind, E extends object>(
  lease: StorageRootLease<K, 'read'>,
  kind: K,
  extension: E,
): Promise<ExecutionStoresReaderBase<K> & E> {
  await assertStorageRootLease(lease, kind, 'read');
  const sessionStore = createSessionStore(lease.canonicalPath);
  const agentRunStore = createSqliteAgentRunStore(lease.canonicalPath);
  const interactionStore =
    'interactionStore' in extension
      ? (extension.interactionStore as InteractiveInteractionStoreReaderFacade)
      : undefined;
  await agentRunStore.ready?.().catch(async (error) => {
    await sessionStore.close?.().catch(() => {});
    agentRunStore.close?.();
    if (interactionStore) closeSqliteInteractionStoreFacade(interactionStore);
    throw error;
  });
  const runtimePersistence = await openRuntimeEventReadPersistence({
    workspaceRoot: lease.canonicalPath,
  }).catch(async (error) => {
    await sessionStore.close?.().catch(() => {});
    agentRunStore.close?.();
    if (interactionStore) closeSqliteInteractionStoreFacade(interactionStore);
    throw error;
  });
  const runtimeEventStore = runtimePersistence.runtimeEventStore;
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, kind, 'read', operation);

  const stores: ExecutionStoresReaderBase<K> & E = {
    ...extension,
    kind,
    [executionStoresReaderBrand]: kind,
    sessionStore: {
      list: (filter) => run(() => sessionStore.list(filter)),
      readHeader: (sessionId) => run(() => sessionStore.readHeaderSnapshot(sessionId)),
      readMessages: (sessionId) => run(() => sessionStore.readMessagesSnapshot(sessionId)),
      listTurns: (sessionId) => run(() => sessionStore.listTurnsSnapshot(sessionId)),
      close: () =>
        closeExecutionStorePersistence(sessionStore, runtimePersistence, {
          agentRunStore,
          interactionStore,
        }),
    },
    agentRunStore: {
      readRun: (sessionId, runId) => run(() => agentRunStore.readRun(sessionId, runId)),
      findRunsById: (runId, limit) => run(() => agentRunStore.findRunsById(runId, limit)),
      listSessionRuns: (sessionId) => run(() => agentRunStore.listSessionRuns(sessionId)),
      listSessionRunsBounded: (sessionId, limit) =>
        run(() => agentRunStore.listSessionRunsBounded(sessionId, limit)),
      readEvents: (sessionId, runId) => run(() => agentRunStore.readEvents(sessionId, runId)),
      readEventsBounded: (sessionId, runId, budget) =>
        run(() => agentRunStore.readEventsBounded(sessionId, runId, budget)),
      readEventProjection: (sessionId, type) =>
        run(() => agentRunStore.readEventProjection(sessionId, type)),
      readRootTurnAdmission: (sessionId, turnId) =>
        run(() => agentRunStore.readRootTurnAdmission(sessionId, turnId)),
      readRootTurnSourceMessageReceipt: (sessionId, sourceMessageId) =>
        run(() => agentRunStore.readRootTurnSourceMessageReceipt(sessionId, sourceMessageId)),
    },
    runtimeEventStore: {
      readRuntimeEvents: (sessionId, runId) =>
        run(() => runtimeEventStore.readRuntimeEvents(sessionId, runId)),
      readRuntimeEventsBounded: (sessionId, runId, budget) =>
        run(() => runtimeEventStore.readRuntimeEventsBounded(sessionId, runId, budget)),
      readImmutableRuntimeEvents: (sessionId, runId) =>
        run(() => runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId)),
      readSessionRuntimeEvents: (sessionId) =>
        run(() => runtimeEventStore.readSessionRuntimeEvents(sessionId)),
    },
  };
  freezeExecutionStoresFacade(stores);
  executionStoresReaderKinds.set(stores, kind);
  return stores;
}

function freezeExecutionStoresFacade(stores: {
  readonly sessionStore: object;
  readonly agentRunStore: object;
  readonly runtimeEventStore: object;
  readonly messageReceiptStore?: object;
}): void {
  Object.freeze(stores.sessionStore);
  Object.freeze(stores.agentRunStore);
  Object.freeze(stores.runtimeEventStore);
  if (stores.messageReceiptStore) Object.freeze(stores.messageReceiptStore);
  Object.freeze(stores);
}

async function closeExecutionStorePersistence(
  sessionStore: { close?(): Promise<void> },
  runtimePersistence: { close(): void },
  extras: {
    agentRunStore?: Pick<DurableAgentRunStore, 'close'>;
    conversationOperationalStateStore?: Pick<ConversationOperationalStateStore, 'close'>;
    messageReceiptStore?: { close(): void };
    interactionStore?:
      | InteractiveInteractionStoreReaderFacade
      | InteractiveInteractionStoreWriterFacade;
  } = {},
): Promise<void> {
  const errors: unknown[] = [];
  try {
    runtimePersistence.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await sessionStore.close?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    extras.agentRunStore?.close?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    extras.conversationOperationalStateStore?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    extras.messageReceiptStore?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    if (extras.interactionStore) {
      closeSqliteInteractionStoreFacade(extras.interactionStore);
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Unable to close execution store persistence');
  }
}

function invalidExecutionStores(
  kind: StorageRootKind,
  access: 'read' | 'write',
): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    `Expected authentic ${kind} ${access} execution stores`,
  );
}
