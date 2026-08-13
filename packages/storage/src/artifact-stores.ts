import type { ArtifactRecord } from '@maka/core/artifacts';
import {
  createSqliteArtifactStoreWriteAuthority,
  type ArtifactAuthorityStore,
  type ArtifactStoreWriteAuthority,
  type ConversationArtifactCopyInput,
  type ConversationArtifactCopyResult,
  type CreateArtifactInput,
  type DurableArtifactAttachmentReader,
} from './artifact-store.js';

export { sanitizeArtifactName } from './artifact-store.js';
import {
  assertStorageRootLease,
  createStorageRootLeaseIdentityGuard,
  prepareArtifactWriterLockAuthorityForLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';

export {
  createArtifactAttachmentResourceReader,
  createAttachmentByteReader,
  createReadImageSnapshotter,
  type ArtifactAttachmentResourceReader,
} from './artifact-attachments.js';
export { persistProviderRequestCaptureArtifact } from './provider-request-capture-artifact.js';

const writerBrand: unique symbol = Symbol('InteractiveArtifactStoreWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveArtifactStoreWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveArtifactStoreWriter>>();

export interface InteractiveArtifactStoreWriter extends DurableArtifactAttachmentReader {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  recover(): Promise<void>;
  create(input: CreateArtifactInput): Promise<ArtifactRecord>;
  deleteOwnedDeepResearchArtifactInSession(sessionId: string, artifactId: string): Promise<void>;
  copyConversationArtifacts(
    input: ConversationArtifactCopyInput,
  ): Promise<ConversationArtifactCopyResult>;
  purgeSessionArtifacts(sessionId: string): Promise<void>;
  listPage: ArtifactAuthorityStore['listPage'];
  listTurnArtifacts: ArtifactAuthorityStore['listTurnArtifacts'];
  getInSession: ArtifactAuthorityStore['getInSession'];
  readTextInSession: ArtifactAuthorityStore['readTextInSession'];
  readBinaryInSession: ArtifactAuthorityStore['readBinaryInSession'];
  readChunkInSession: ArtifactAuthorityStore['readChunkInSession'];
  deleteUserArtifactInSession: ArtifactAuthorityStore['deleteUserArtifactInSession'];
  close(): void;
}

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
    const authority = createSqliteArtifactStoreWriteAuthority(lease.canonicalPath, {
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
    listTurnArtifacts: (sessionId, turnId) => run(() => store.listTurnArtifacts(sessionId, turnId)),
    getInSession: (sessionId, artifactId) => run(() => store.getInSession(sessionId, artifactId)),
    readTextInSession: (sessionId, artifactId, options) =>
      run(() => store.readTextInSession(sessionId, artifactId, options)),
    readBinaryInSession: (sessionId, artifactId, options) =>
      run(() => store.readBinaryInSession(sessionId, artifactId, options)),
    readChunkInSession: (sessionId, artifactId, options) =>
      run(() => store.readChunkInSession(sessionId, artifactId, options)),
    readDurableAttachmentBinary: (input) => run(() => store.readDurableAttachmentBinary(input)),
    recover: () => run(() => authority.recover()),
    create: (input) => {
      const acceptedInput = snapshotCreateInput(input);
      return run(() => store.create(acceptedInput));
    },
    deleteOwnedDeepResearchArtifactInSession: (sessionId, artifactId) =>
      run(async () => {
        const entry = await store.getInSession(sessionId, artifactId);
        if (!entry.record || entry.record.source !== 'deep_research') {
          throw new Error('Artifact does not belong to the expected Session authority');
        }
        await store.delete(artifactId);
      }),
    copyConversationArtifacts: (input) => {
      const acceptedInput: ConversationArtifactCopyInput = Object.freeze({
        ...input,
        turnIds: Object.freeze([...input.turnIds]),
      });
      return run(() => store.copyConversationArtifacts(acceptedInput));
    },
    purgeSessionArtifacts: (sessionId) => run(() => store.purgeSessionArtifacts(sessionId)),
    deleteUserArtifactInSession: (sessionId, artifactId) =>
      run(() => store.deleteUserArtifactInSession(sessionId, artifactId)),
    close: () => {
      if (writerByLease.get(lease) === facade) writerByLease.delete(lease);
      authority.close();
    },
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
