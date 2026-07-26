import { createArtifactStore, type ArtifactStore } from '@maka/storage';
import {
  authenticateExecutionStoresReader,
  authenticateExecutionStoresWriter,
  openHeadlessExecutionStoresForRead,
  openHeadlessExecutionStoresForWrite,
  type ExecutionStoresReader,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import {
  createHeadlessRootLease,
  discoverMarkedStorageRoot,
  resolveStorageRoot,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type DiscoveredStorageRootCapability,
  type StorageRootCapability,
  type StorageRootLease,
} from '@maka/storage/root-authority';
import {
  openHeadlessTaskRunReader,
  openHeadlessTaskRunWriter,
  type TaskRunReader,
  type TaskRunWriter,
} from './task-run-store.js';

const headlessStorageWriterBrand: unique symbol = Symbol('HeadlessStorageWriter');
const headlessStorageReaderBrand: unique symbol = Symbol('HeadlessStorageReader');
const headlessStorageWriters = new WeakSet<object>();
const headlessStorageReaders = new WeakSet<object>();

export type HeadlessArtifactStore = Readonly<
  Pick<
    ArtifactStore,
    'create' | 'list' | 'readText' | 'get' | 'readBinary' | 'readDurableAttachmentBinary'
  >
>;

export interface HeadlessStorageWriter {
  readonly [headlessStorageWriterBrand]: true;
  readonly taskRunStore: Readonly<TaskRunWriter>;
  readonly executionStores: ExecutionStoresWriter<'headless'>;
  readonly artifactStore: HeadlessArtifactStore;
}

export interface HeadlessStorageReader {
  readonly [headlessStorageReaderBrand]: true;
  readonly taskRunStore: Readonly<TaskRunReader>;
  readonly executionStores: ExecutionStoresReader<'headless'>;
}

export async function openHeadlessStorageForWrite(
  storageRoot: string,
): Promise<HeadlessStorageWriter> {
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'headless' });
  const lease = createHeadlessRootLease(capability, 'write');
  const [taskRunStore, executionStores] = await Promise.all([
    openHeadlessTaskRunWriter(lease),
    openHeadlessExecutionStoresForWrite(lease),
  ]);

  const storage: HeadlessStorageWriter = {
    [headlessStorageWriterBrand]: true,
    taskRunStore,
    executionStores,
    artifactStore: leaseBoundArtifactStore(lease),
  };
  Object.freeze(storage);
  headlessStorageWriters.add(storage);
  return storage;
}

export async function openHeadlessStorageForRead(
  source: string | StorageRootCapability<'headless'>,
): Promise<HeadlessStorageReader> {
  const capability =
    typeof source === 'string'
      ? requireHeadlessCapability(await discoverMarkedStorageRoot({ path: source }))
      : source;
  const lease = createHeadlessRootLease(capability, 'read');
  const [taskRunStore, executionStores] = await Promise.all([
    openHeadlessTaskRunReader(lease),
    openHeadlessExecutionStoresForRead(lease),
  ]);

  const storage: HeadlessStorageReader = {
    [headlessStorageReaderBrand]: true,
    taskRunStore,
    executionStores,
  };
  Object.freeze(storage);
  headlessStorageReaders.add(storage);
  return storage;
}

export function authenticateHeadlessStorageWriter(
  storage: HeadlessStorageWriter,
): HeadlessStorageWriter {
  if (!headlessStorageWriters.has(storage)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic Headless storage writer',
    );
  }
  authenticateExecutionStoresWriter(storage.executionStores, 'headless');
  return storage;
}

export function authenticateHeadlessStorageReader(
  storage: HeadlessStorageReader,
): HeadlessStorageReader {
  if (!headlessStorageReaders.has(storage)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic Headless storage reader',
    );
  }
  authenticateExecutionStoresReader(storage.executionStores, 'headless');
  return storage;
}

export function isStorageRootAuthorityError(error: unknown): error is StorageRootAuthorityError {
  return error instanceof StorageRootAuthorityError;
}

function requireHeadlessCapability(
  capability: DiscoveredStorageRootCapability,
): StorageRootCapability<'headless'> {
  if (capability.kind !== 'headless') {
    throw new StorageRootAuthorityError(
      'root_kind_mismatch',
      `Storage root ${capability.canonicalPath} is ${capability.kind}, not headless`,
    );
  }
  return capability;
}

function leaseBoundArtifactStore(
  lease: StorageRootLease<'headless', 'write'>,
): HeadlessArtifactStore {
  const store = createArtifactStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'headless', 'write', operation);
  const facade: HeadlessArtifactStore = {
    create: (input) => run(() => store.create(input)),
    list: (sessionId, options) => run(() => store.list(sessionId, options)),
    get: (artifactId) => run(() => store.get(artifactId)),
    readText: (artifactId, options) => run(() => store.readText(artifactId, options)),
    readBinary: (artifactId, options) => run(() => store.readBinary(artifactId, options)),
    readDurableAttachmentBinary: (input) => run(() => store.readDurableAttachmentBinary(input)),
  };
  return Object.freeze(facade);
}
