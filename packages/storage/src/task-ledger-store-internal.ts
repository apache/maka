import type { Task, TaskLedgerListOptions, TaskLedgerStore } from '@maka/core/task-ledger';

export interface TaskLedgerCanonicalReader {
  list(sessionId: string, options?: TaskLedgerListOptions): Promise<Task[]>;
  get(sessionId: string, id: string, options?: TaskLedgerListOptions): Promise<Task | undefined>;
}

// Package-private bridge: this module must stay outside both the root barrel and package exports.
const canonicalReaderByStore = new WeakMap<object, TaskLedgerCanonicalReader>();

export function registerTaskLedgerCanonicalReader(
  store: TaskLedgerStore,
  reader: TaskLedgerCanonicalReader,
): void {
  if (canonicalReaderByStore.has(store)) {
    throw new Error('Task ledger store already has a canonical reader');
  }
  canonicalReaderByStore.set(store, Object.freeze(reader));
}

export function getTaskLedgerCanonicalReader(store: TaskLedgerStore): TaskLedgerCanonicalReader {
  const reader = canonicalReaderByStore.get(store);
  if (!reader) throw new Error('Task ledger store is missing its internal canonical reader');
  return reader;
}
