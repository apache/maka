import type { ArtifactRecord } from '@maka/core/artifacts';
import {
  createArtifactStore,
  type ArtifactStoreReader,
  type CreateArtifactInput,
  type DurableArtifactAttachmentReader,
} from './artifact-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';

const readerBrand: unique symbol = Symbol('InteractiveArtifactStoreReader');
const writerBrand: unique symbol = Symbol('InteractiveArtifactStoreWriter');
const readers = new WeakSet<object>();
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveArtifactStoreWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveArtifactStoreWriter>>();

export interface InteractiveArtifactStoreReader extends ArtifactStoreReader {
  readonly kind: 'interactive';
  readonly access: 'read';
  readonly [readerBrand]: true;
}

export interface InteractiveArtifactStoreWriter
  extends ArtifactStoreReader,
    DurableArtifactAttachmentReader {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  recover(): Promise<void>;
  create(input: CreateArtifactInput): Promise<ArtifactRecord>;
  delete(artifactId: string): Promise<void>;
  purge(artifactIds: readonly string[]): Promise<void>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}

export class ArtifactStoreLifecycleError extends Error {
  constructor(readonly code: 'draining' | 'closed') {
    super(
      code === 'draining' ? 'Artifact store writer is draining' : 'Artifact store writer is closed',
    );
    this.name = 'ArtifactStoreLifecycleError';
  }
}

export function authenticateInteractiveArtifactStoreReader(
  store: InteractiveArtifactStoreReader,
): InteractiveArtifactStoreReader {
  if (!readers.has(store)) throw invalidFacade('read');
  return store;
}

export function authenticateInteractiveArtifactStoreWriter(
  store: InteractiveArtifactStoreWriter,
): InteractiveArtifactStoreWriter {
  if (!writers.has(store)) throw invalidFacade('write');
  return store;
}

export async function openInteractiveArtifactStoreForRead(
  lease: StorageRootLease<'interactive', 'read'>,
): Promise<InteractiveArtifactStoreReader> {
  await assertStorageRootLease(lease, 'interactive', 'read');
  const store = createArtifactStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'read', operation);
  const facade: InteractiveArtifactStoreReader = {
    kind: 'interactive',
    access: 'read',
    [readerBrand]: true,
    list: (sessionId, options) => run(() => store.list(sessionId, options)),
    get: (artifactId) => run(() => store.get(artifactId)),
    readText: (artifactId, options) => run(() => store.readText(artifactId, options)),
    readBinary: (artifactId, options) => run(() => store.readBinary(artifactId, options)),
  };
  Object.freeze(facade);
  readers.add(facade);
  return facade;
}

export async function openInteractiveArtifactStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveArtifactStoreWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    const store = createArtifactStore(lease.canonicalPath);
    await assertStorageRootLease(lease, 'interactive', 'write');
    const recoveredExisting = writerByLease.get(lease);
    if (recoveredExisting) return recoveredExisting;
    const facade = createWriterFacade(lease, store);
    writers.add(facade);
    writerByLease.set(lease, facade);
    return facade;
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  store: ReturnType<typeof createArtifactStore>,
): InteractiveArtifactStoreWriter {
  const lifecycle = new ArtifactWriterLifecycle();
  const read = <T>(operation: () => Promise<T>) => {
    lifecycle.assertReadable();
    return runWithStorageRootLease(lease, 'interactive', 'write', operation);
  };
  const mutate = <T>(operation: () => Promise<T>) =>
    lifecycle.runMutation(() => runWithStorageRootLease(lease, 'interactive', 'write', operation));
  const facade: InteractiveArtifactStoreWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    list: (sessionId, options) => read(() => store.list(sessionId, options)),
    get: (artifactId) => read(() => store.get(artifactId)),
    readText: (artifactId, options) => read(() => store.readText(artifactId, options)),
    readBinary: (artifactId, options) => read(() => store.readBinary(artifactId, options)),
    readDurableAttachmentBinary: (input) => read(() => store.readDurableAttachmentBinary(input)),
    recover: () => mutate(() => store.recoverForWrite()),
    create: (input) => mutate(() => store.create(input)),
    delete: (artifactId) => mutate(() => store.delete(artifactId)),
    purge: (artifactIds) => mutate(() => store.purge(artifactIds)),
    beginDrain: () => lifecycle.beginDrain(),
    close: () => lifecycle.close(),
  };
  return Object.freeze(facade);
}

class ArtifactWriterLifecycle {
  private state: 'open' | 'draining' | 'closed' = 'open';
  private activeMutations = 0;
  private readonly drainWaiters = new Set<() => void>();
  private closePromise: Promise<void> | undefined;

  assertReadable(): void {
    if (this.state === 'closed') throw new ArtifactStoreLifecycleError('closed');
  }

  runMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== 'open') return Promise.reject(new ArtifactStoreLifecycleError(this.state));
    this.activeMutations += 1;
    return operation().finally(() => {
      this.activeMutations -= 1;
      if (this.activeMutations !== 0) return;
      for (const resolve of this.drainWaiters) resolve();
      this.drainWaiters.clear();
    });
  }

  beginDrain(): Promise<void> {
    if (this.state === 'open') this.state = 'draining';
    return this.waitForMutations();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.beginDrain().then(() => {
      this.state = 'closed';
    });
    return this.closePromise;
  }

  private waitForMutations(): Promise<void> {
    return this.activeMutations === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }
}

function invalidFacade(access: 'read' | 'write'): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    `Expected authentic interactive ${access} artifact store`,
  );
}
