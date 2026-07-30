import type { TaskLedgerStore } from '@maka/core/task-ledger';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import { createTaskLedgerStore } from './task-ledger-store.js';
import {
  getTaskLedgerCanonicalReader,
  type TaskLedgerCanonicalReader,
} from './task-ledger-store-internal.js';

export type { TaskLedgerCanonicalReader } from './task-ledger-store-internal.js';

const writerBrand: unique symbol = Symbol('InteractiveTaskLedgerWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveTaskLedgerWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveTaskLedgerWriter>>();

export interface InteractiveTaskLedgerWriter extends TaskLedgerStore, TaskLedgerCanonicalReader {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
}

export function authenticateInteractiveTaskLedgerWriter(
  writer: InteractiveTaskLedgerWriter,
): InteractiveTaskLedgerWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive task ledger writer',
    );
  }
  return writer;
}

export async function openInteractiveTaskLedgerStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveTaskLedgerWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    const store = await runWithStorageRootLease(lease, 'interactive', 'write', async (root) =>
      createTaskLedgerStore(root),
    );
    await assertStorageRootLease(lease, 'interactive', 'write');
    const recoveredExisting = writerByLease.get(lease);
    if (recoveredExisting) return recoveredExisting;
    const writer = createInteractiveWriterFacade(lease, store, getTaskLedgerCanonicalReader(store));
    writers.add(writer);
    writerByLease.set(lease, writer);
    return writer;
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

function createInteractiveWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  store: TaskLedgerStore,
  canonicalReader: TaskLedgerCanonicalReader,
): InteractiveTaskLedgerWriter {
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'write', async () => operation());
  const writer: InteractiveTaskLedgerWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    list: (sessionId, options) => run(() => canonicalReader.list(sessionId, options)),
    get: (sessionId, id, options) => run(() => canonicalReader.get(sessionId, id, options)),
    create: (sessionId, drafts, context) => run(() => store.create(sessionId, drafts, context)),
    update: (sessionId, id, patch, context) =>
      run(() => store.update(sessionId, id, patch, context)),
    claim: (sessionId, id, owner, context) => run(() => store.claim(sessionId, id, owner, context)),
    claimAvailable: (sessionId, id, owner, scope, context) =>
      run(() => store.claimAvailable(sessionId, id, owner, scope, context)),
    settleAgentOutcome: (sessionId, id, outcome, context) =>
      run(() => store.settleAgentOutcome(sessionId, id, outcome, context)),
    subscribe: (listener) => store.subscribe(listener),
  };
  Object.freeze(writer);
  return writer;
}
