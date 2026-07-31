import type {
  AgentRunEvent,
  AgentRunEventType,
  AgentRunHeader,
  RuntimeEvent,
  SessionHeader,
  SessionListFilter,
  SessionSummary,
  StoredMessage,
  TurnRecord,
} from '@maka/core';
import {
  createAgentRunStore,
  type AdmitRootTurnInput,
  type AdmitRootTurnResult,
  type DurableAgentRunStore,
  type DurableRuntimeEventStore,
  type RootTurnAdmission,
  type RootTurnSourceMessageReceipt,
} from './agent-run-store.js';
import { createMessageReceiptStore, type MessageReceiptStore } from './message-receipt-store.js';
import { createSessionStore, type SessionAuthorityStore } from './session-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootKind,
  type StorageRootLease,
} from './root-authority.js';
import {
  openInteractiveInteractionStoreForRead,
  openInteractiveInteractionStoreForWrite,
  type InteractiveInteractionStoreReaderFacade,
  type InteractiveInteractionStoreWriterFacade,
} from './interaction-store.js';
import {
  openRuntimeEventPersistence,
  openRuntimeEventReadPersistence,
} from './runtime-event-transfer.js';

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
  AdmitRootTurnInput,
  AdmitRootTurnResult,
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
  SessionCatalogPageCursor,
  SessionCatalogPageResult,
  SessionCatalogRecord,
} from './session-store.js';

export type ExecutionSessionWriter = SessionAuthorityStore;
export type ExecutionAgentRunWriter = DurableAgentRunStore;
export type ExecutionRuntimeEventWriter = DurableRuntimeEventStore;
export type ExecutionMessageReceiptWriter = MessageReceiptStore;

interface ExecutionStoresWriterBase<K extends StorageRootKind> {
  readonly kind: K;
  readonly [executionStoresWriterBrand]: K;
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
  listSessionRuns(sessionId: string): Promise<AgentRunHeader[]>;
  readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
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
  const interactionStore = await openInteractiveInteractionStoreForWrite(lease);
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
  const agentRunStore = createAgentRunStore(lease.canonicalPath);
  const runtimePersistence = await openRuntimeEventPersistence({
    workspaceRoot: lease.canonicalPath,
  }).catch(async (error) => {
    await sessionStore.close?.().catch(() => {});
    throw error;
  });
  const runtimeEventStore = runtimePersistence.runtimeEventStore;
  const messageReceiptStore = createMessageReceiptStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, kind, 'write', operation);

  const stores: ExecutionStoresWriterBase<K> & E = {
    ...extension,
    kind,
    [executionStoresWriterBrand]: kind,
    sessionStore: {
      create: (input, initialBoundary) => run(() => sessionStore.create(input, initialBoundary)),
      probeStableSessionCreate: (sessionId, requestFingerprint) =>
        run(() => sessionStore.probeStableSessionCreate(sessionId, requestFingerprint)),
      createStableSession: (request, initialBoundary) =>
        run(() => sessionStore.createStableSession(request, initialBoundary)),
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
      listForRecovery: () => run(() => sessionStore.listForRecovery()),
      readHeaderSnapshot: (sessionId) => run(() => sessionStore.readHeaderSnapshot(sessionId)),
      readHeaderRecordSnapshot: (sessionId) =>
        run(() => sessionStore.readHeaderRecordSnapshot(sessionId)),
      readCatalogRecord: (sessionId) => run(() => sessionStore.readCatalogRecord(sessionId)),
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
      close: () => closeExecutionStorePersistence(sessionStore, runtimePersistence),
    },
    agentRunStore: {
      createRun: (header, options) => run(() => agentRunStore.createRun(header, options)),
      updateRun: (sessionId, runId, patch, options) =>
        run(() => agentRunStore.updateRun(sessionId, runId, patch, options)),
      readRun: (sessionId, runId) => run(() => agentRunStore.readRun(sessionId, runId)),
      listSessionRuns: (sessionId) => run(() => agentRunStore.listSessionRuns(sessionId)),
      listSessionRunsForRecovery: (sessionId) =>
        run(() => agentRunStore.listSessionRunsForRecovery(sessionId)),
      appendEvent: (sessionId, runId, event, options) =>
        run(() => agentRunStore.appendEvent(sessionId, runId, event, options)),
      readEvents: (sessionId, runId) => run(() => agentRunStore.readEvents(sessionId, runId)),
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
      appendRuntimeEvent: (sessionId, runId, event, options) =>
        run(() => runtimeEventStore.appendRuntimeEvent(sessionId, runId, event, options)),
      ensureTerminalRuntimeEventDurable: (sessionId, runId, event) =>
        run(() => runtimeEventStore.ensureTerminalRuntimeEventDurable(sessionId, runId, event)),
      readRuntimeEvents: (sessionId, runId) =>
        run(() => runtimeEventStore.readRuntimeEvents(sessionId, runId)),
      readImmutableRuntimeEvents: (sessionId, runId) =>
        run(() => runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId)),
      readSessionRuntimeEvents: (sessionId) =>
        run(() => runtimeEventStore.readSessionRuntimeEvents(sessionId)),
      readImmutableSteeringMessageProof: (sessionId, messageId) =>
        run(() => runtimeEventStore.readImmutableSteeringMessageProof(sessionId, messageId)),
      repairImmutableSteeringMessageProofsForRecovery: (sessionId) =>
        run(() => runtimeEventStore.repairImmutableSteeringMessageProofsForRecovery(sessionId)),
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
  const interactionStore = await openInteractiveInteractionStoreForRead(lease);
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
  const agentRunStore = createAgentRunStore(lease.canonicalPath);
  const runtimePersistence = await openRuntimeEventReadPersistence({
    workspaceRoot: lease.canonicalPath,
  }).catch(async (error) => {
    await sessionStore.close?.().catch(() => {});
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
      close: () => closeExecutionStorePersistence(sessionStore, runtimePersistence),
    },
    agentRunStore: {
      readRun: (sessionId, runId) => run(() => agentRunStore.readRun(sessionId, runId)),
      listSessionRuns: (sessionId) => run(() => agentRunStore.listSessionRuns(sessionId)),
      readEvents: (sessionId, runId) => run(() => agentRunStore.readEvents(sessionId, runId)),
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
