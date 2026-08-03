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
  if (!(await recovery.confirmRepair())) return undefined;
  return repairStorageRootIdentity(candidate);
}
