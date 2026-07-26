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
  createRuntimeEventStore,
  type AdmitRootTurnInput,
  type AdmitRootTurnResult,
  type DurableAgentRunStore,
  type DurableRuntimeEventStore,
  type RootTurnAdmission,
  type RootTurnSourceMessageReceipt,
} from './agent-run-store.js';
import { createMessageReceiptStore, type MessageReceiptStore } from './message-receipt-store.js';
import { createSessionStore, type SessionStore } from './session-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootKind,
  type StorageRootLease,
} from './root-authority.js';

const executionStoresWriterBrand: unique symbol = Symbol('ExecutionStoresWriter');
const executionStoresReaderBrand: unique symbol = Symbol('ExecutionStoresReader');
const executionStoresWriterKinds = new WeakMap<object, StorageRootKind>();
const executionStoresReaderKinds = new WeakMap<object, StorageRootKind>();
const executionStoresWritersByLease = new WeakMap<object, ExecutionStoresWriter<StorageRootKind>>();

export { normalizeRootTurnAdmissionPayload } from './agent-run-store.js';
export { isSessionNotFoundError } from './session-store.js';

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

export type ExecutionSessionWriter = SessionStore;
export type ExecutionAgentRunWriter = DurableAgentRunStore;
export type ExecutionRuntimeEventWriter = DurableRuntimeEventStore;
export type ExecutionMessageReceiptWriter = MessageReceiptStore;

export interface ExecutionStoresWriter<K extends StorageRootKind> {
  readonly kind: K;
  readonly [executionStoresWriterBrand]: K;
  readonly sessionStore: Readonly<ExecutionSessionWriter>;
  readonly agentRunStore: Readonly<ExecutionAgentRunWriter>;
  readonly runtimeEventStore: Readonly<ExecutionRuntimeEventWriter>;
  readonly messageReceiptStore: Readonly<ExecutionMessageReceiptWriter>;
}

export interface ExecutionSessionReader {
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
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

export interface ExecutionStoresReader<K extends StorageRootKind> {
  readonly kind: K;
  readonly [executionStoresReaderBrand]: K;
  readonly sessionStore: Readonly<ExecutionSessionReader>;
  readonly agentRunStore: Readonly<ExecutionAgentRunReader>;
  readonly runtimeEventStore: Readonly<ExecutionRuntimeEventReader>;
}

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
  return openExecutionStoresForWrite(lease, 'interactive');
}

export async function openHeadlessExecutionStoresForWrite(
  lease: StorageRootLease<'headless', 'write'>,
): Promise<ExecutionStoresWriter<'headless'>> {
  return openExecutionStoresForWrite(lease, 'headless');
}

async function openExecutionStoresForWrite<K extends StorageRootKind>(
  lease: StorageRootLease<K, 'write'>,
  kind: K,
): Promise<ExecutionStoresWriter<K>> {
  await assertStorageRootLease(lease, kind, 'write');
  const existing = executionStoresWritersByLease.get(lease);
  if (existing) return existing as ExecutionStoresWriter<K>;

  const sessionStore = createSessionStore(lease.canonicalPath);
  const agentRunStore = createAgentRunStore(lease.canonicalPath);
  const runtimeEventStore = createRuntimeEventStore(lease.canonicalPath);
  const messageReceiptStore = createMessageReceiptStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, kind, 'write', operation);

  const stores: ExecutionStoresWriter<K> = {
    kind,
    [executionStoresWriterBrand]: kind,
    sessionStore: {
      create: (input) => run(() => sessionStore.create(input)),
      createSubagent: (input) => run(() => sessionStore.createSubagent(input)),
      list: (filter) => run(() => sessionStore.list(filter)),
      listForRecovery: () => run(() => sessionStore.listForRecovery()),
      readHeaderSnapshot: (sessionId) => run(() => sessionStore.readHeaderSnapshot(sessionId)),
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
      close: async () => {
        await sessionStore.close?.();
      },
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
  return openExecutionStoresForRead(lease, 'interactive');
}

export async function openHeadlessExecutionStoresForRead(
  lease: StorageRootLease<'headless', 'read'>,
): Promise<ExecutionStoresReader<'headless'>> {
  return openExecutionStoresForRead(lease, 'headless');
}

async function openExecutionStoresForRead<K extends StorageRootKind>(
  lease: StorageRootLease<K, 'read'>,
  kind: K,
): Promise<ExecutionStoresReader<K>> {
  await assertStorageRootLease(lease, kind, 'read');
  const sessionStore = createSessionStore(lease.canonicalPath);
  const agentRunStore = createAgentRunStore(lease.canonicalPath);
  const runtimeEventStore = createRuntimeEventStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, kind, 'read', operation);

  const stores: ExecutionStoresReader<K> = {
    kind,
    [executionStoresReaderBrand]: kind,
    sessionStore: {
      list: (filter) => run(() => sessionStore.list(filter)),
      readHeader: (sessionId) => run(() => sessionStore.readHeaderSnapshot(sessionId)),
      readMessages: (sessionId) => run(() => sessionStore.readMessagesSnapshot(sessionId)),
      listTurns: (sessionId) => run(() => sessionStore.listTurnsSnapshot(sessionId)),
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

function invalidExecutionStores(
  kind: StorageRootKind,
  access: 'read' | 'write',
): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    `Expected authentic ${kind} ${access} execution stores`,
  );
}
