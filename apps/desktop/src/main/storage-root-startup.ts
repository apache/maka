import {
  prepareStorageRootIdentityRepair,
  repairStorageRootIdentity,
  resolveStorageRoot,
  StorageRootAuthorityError,
  type StorageRootCapability,
} from '@maka/storage/root-authority';

export interface DesktopStorageRootRecovery {
  confirmRepair(): Promise<boolean>;
}

export async function resolveDesktopStorageRoot(
  path: string,
  recovery: DesktopStorageRootRecovery,
): Promise<StorageRootCapability<'interactive'> | undefined> {
  try {
    return await resolveStorageRoot({ path, kind: 'interactive' });
  } catch (error) {
    if (
      !(error instanceof StorageRootAuthorityError) ||
      error.code !== 'root_identity_collision'
    ) {
      throw error;
    }
  }

  const candidate = await prepareStorageRootIdentityRepair({
    path,
    kind: 'interactive',
  });
  if (!candidate) return resolveStorageRoot({ path, kind: 'interactive' });
  // The classification travels on the candidate, decided by the storage layer
  // from the marker this candidate was prepared against. Reading the marker
  // again here would be a second answer to the same question, and the two can
  // disagree if it is swapped in between — which is how a foreign root could
  // be adopted without anyone confirming it.
  if (candidate.drift === 'remounted') {
    console.log('[storage-root] the volume was mounted again; refreshing the recorded identity');
    return repairStorageRootIdentity(candidate);
  }
  if (!(await recovery.confirmRepair())) return undefined;
  return repairStorageRootIdentity(candidate);
}
