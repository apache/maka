import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import { createProjectCatalog, type ProjectCatalog } from './project-catalog.js';

const writerBrand: unique symbol = Symbol('InteractiveProjectCatalogWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveProjectCatalogWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveProjectCatalogWriter>>();

export interface InteractiveProjectCatalogWriter extends ProjectCatalog {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
}

export function authenticateInteractiveProjectCatalogWriter(
  writer: InteractiveProjectCatalogWriter,
): InteractiveProjectCatalogWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive Project Catalog writer',
    );
  }
  return writer;
}

export async function openInteractiveProjectCatalogForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveProjectCatalogWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    let catalog: ProjectCatalog | undefined;
    try {
      catalog = await runWithStorageRootLease(lease, 'interactive', 'write', async (root) =>
        createProjectCatalog(root),
      );
      await assertStorageRootLease(lease, 'interactive', 'write');
      const recoveredExisting = writerByLease.get(lease);
      if (recoveredExisting) {
        catalog.close();
        return recoveredExisting;
      }
      const writer = createWriterFacade(lease, catalog);
      writers.add(writer);
      writerByLease.set(lease, writer);
      return writer;
    } catch (error) {
      catalog?.close();
      throw error;
    }
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
  catalog: ProjectCatalog,
): InteractiveProjectCatalogWriter {
  let closed = false;
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Project Catalog writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', operation);
  };
  const writer: InteractiveProjectCatalogWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    list: () => run(() => catalog.list()),
    register: (path) => run(() => catalog.register(path)),
    resolveHistoricalPath: (path, usedAt) => run(() => catalog.resolveHistoricalPath(path, usedAt)),
    select: (projectId) => run(() => catalog.select(projectId)),
    touch: (projectId, path) => run(() => catalog.touch(projectId, path)),
    relink: (projectId, path) => run(() => catalog.relink(projectId, path)),
    relinkWithSessions: (projectId, path) => run(() => catalog.relinkWithSessions(projectId, path)),
    rename: (projectId, name) => run(() => catalog.rename(projectId, name)),
    archive: (projectId) => run(() => catalog.archive(projectId)),
    restore: (projectId) => run(() => catalog.restore(projectId)),
    close: () => {
      if (closed) return;
      closed = true;
      if (writerByLease.get(lease) === writer) writerByLease.delete(lease);
      writers.delete(writer);
      catalog.close();
    },
  };
  return Object.freeze(writer);
}
