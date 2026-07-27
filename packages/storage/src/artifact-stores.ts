import type { ArtifactRecord } from '@maka/core/artifacts';
import {
  createArtifactStoreWriteAuthority,
  type ArtifactAuthorityStore,
  type ArtifactStoreWriteAuthority,
  type CreateArtifactInput,
  type DurableArtifactAttachmentReader,
} from './artifact-store.js';
import {
  assertStorageRootLease,
  createStorageRootLeaseIdentityGuard,
  prepareArtifactWriterLockAuthorityForLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';

const writerBrand: unique symbol = Symbol('InteractiveArtifactStoreWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveArtifactStoreWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveArtifactStoreWriter>>();
const headlessWriterByLease = new WeakMap<object, HeadlessArtifactStoreWriter>();
const headlessWriterOpeningByLease = new WeakMap<object, Promise<HeadlessArtifactStoreWriter>>();

export interface InteractiveArtifactStoreWriter extends DurableArtifactAttachmentReader {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  recover(): Promise<void>;
  create(input: CreateArtifactInput): Promise<ArtifactRecord>;
  listPage: ArtifactAuthorityStore['listPage'];
  getInSession: ArtifactAuthorityStore['getInSession'];
  readTextInSession: ArtifactAuthorityStore['readTextInSession'];
  readBinaryInSession: ArtifactAuthorityStore['readBinaryInSession'];
  deleteUserArtifactInSession: ArtifactAuthorityStore['deleteUserArtifactInSession'];
}

export type HeadlessArtifactStoreWriter = Readonly<
  Pick<
    ArtifactAuthorityStore,
    'create' | 'list' | 'get' | 'readText' | 'readBinary' | 'readDurableAttachmentBinary'
  >
>;

export function authenticateInteractiveArtifactStoreWriter(
  store: InteractiveArtifactStoreWriter,
): InteractiveArtifactStoreWriter {
  if (!writers.has(store)) throw invalidFacade();
  return store;
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
    const leaseBoundWriterLockAuthority = await prepareArtifactWriterLockAuthorityForLease(
      lease,
      'interactive',
    );
    const assertAuthority = createStorageRootLeaseIdentityGuard(lease, 'interactive', 'write');
    const authority = createArtifactStoreWriteAuthority(lease.canonicalPath, {
      assertAuthority,
      leaseBoundWriterLockAuthority,
    });
    await assertStorageRootLease(lease, 'interactive', 'write');
    const recoveredExisting = writerByLease.get(lease);
    if (recoveredExisting) return recoveredExisting;
    const facade = createWriterFacade(lease, authority);
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

export async function openHeadlessArtifactStoreForWrite(
  lease: StorageRootLease<'headless', 'write'>,
): Promise<HeadlessArtifactStoreWriter> {
  await assertStorageRootLease(lease, 'headless', 'write');
  const existing = headlessWriterByLease.get(lease);
  if (existing) return existing;
  const opening = headlessWriterOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    const leaseBoundWriterLockAuthority = await prepareArtifactWriterLockAuthorityForLease(
      lease,
      'headless',
    );
    const assertAuthority = createStorageRootLeaseIdentityGuard(lease, 'headless', 'write');
    const authority = createArtifactStoreWriteAuthority(lease.canonicalPath, {
      assertAuthority,
      leaseBoundWriterLockAuthority,
    });
    const run = <T>(operation: () => Promise<T>) =>
      runWithStorageRootLease(lease, 'headless', 'write', operation);
    await run(() => authority.recover());
    const recoveredExisting = headlessWriterByLease.get(lease);
    if (recoveredExisting) return recoveredExisting;
    const facade = createHeadlessWriterFacade(lease, authority);
    headlessWriterByLease.set(lease, facade);
    return facade;
  });
  headlessWriterOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (headlessWriterOpeningByLease.get(lease) === pending) {
      headlessWriterOpeningByLease.delete(lease);
    }
  }
}

function createHeadlessWriterFacade(
  lease: StorageRootLease<'headless', 'write'>,
  authority: ArtifactStoreWriteAuthority,
): HeadlessArtifactStoreWriter {
  const { store } = authority;
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'headless', 'write', operation);
  return Object.freeze({
    create: (input) => {
      const acceptedInput = snapshotCreateInput(input);
      return run(() => store.create(acceptedInput));
    },
    list: (sessionId, options) => run(() => store.list(sessionId, options)),
    get: (artifactId) => run(() => store.get(artifactId)),
    readText: (artifactId, options) => run(() => store.readText(artifactId, options)),
    readBinary: (artifactId, options) => run(() => store.readBinary(artifactId, options)),
    readDurableAttachmentBinary: (input) => run(() => store.readDurableAttachmentBinary(input)),
  });
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  authority: ArtifactStoreWriteAuthority,
): InteractiveArtifactStoreWriter {
  const { store } = authority;
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'write', operation);
  const facade: InteractiveArtifactStoreWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    listPage: (sessionId, options) => run(() => store.listPage(sessionId, options)),
    getInSession: (sessionId, artifactId) => run(() => store.getInSession(sessionId, artifactId)),
    readTextInSession: (sessionId, artifactId, options) =>
      run(() => store.readTextInSession(sessionId, artifactId, options)),
    readBinaryInSession: (sessionId, artifactId, options) =>
      run(() => store.readBinaryInSession(sessionId, artifactId, options)),
    readDurableAttachmentBinary: (input) => run(() => store.readDurableAttachmentBinary(input)),
    recover: () => run(() => authority.recover()),
    create: (input) => {
      const acceptedInput = snapshotCreateInput(input);
      return run(() => store.create(acceptedInput));
    },
    deleteUserArtifactInSession: (sessionId, artifactId) =>
      run(() => store.deleteUserArtifactInSession(sessionId, artifactId)),
  };
  return Object.freeze(facade);
}

function snapshotCreateInput(input: CreateArtifactInput): CreateArtifactInput {
  return Object.freeze({
    ...input,
    content: typeof input.content === 'string' ? input.content : new Uint8Array(input.content),
  });
}

function invalidFacade(): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    'Expected authentic interactive write artifact store',
  );
}
