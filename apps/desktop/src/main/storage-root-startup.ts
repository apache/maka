import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  prepareStorageRootIdentityRepair,
  repairStorageRootIdentity,
  resolveStorageRoot,
  STORAGE_ROOT_MARKER_FILE,
  StorageRootAuthorityError,
  type StorageRootCapability,
} from '@maka/storage/root-authority';

export interface DesktopStorageRootRecovery {
  confirmRepair(): Promise<boolean>;
}

/**
 * Whether the marker is stale only because the volume was mounted again.
 *
 * The marker records `dev` and `ino`. Copying a workspace gives the copy its
 * own inode, which is the case the identity check exists to catch and the only
 * one worth stopping a person for. A device number carries no such meaning
 * across restarts: the kernel hands one out per mount, so an unmoved directory
 * reports a different `dev` after its volume is mounted again, while keeping
 * the inode it always had.
 *
 * Asking about that is worse than useless. It is routine, there is nothing for
 * a person to decide, and the question arrives through a dialog raised before
 * any window exists — which does not appear, leaving the launch hung with the
 * process alive and nothing printed.
 *
 * Returns false whenever the answer is not certain, so anything genuinely
 * ambiguous still reaches the person.
 */
async function onlyTheDeviceNumberMoved(root: string): Promise<boolean> {
  try {
    const [marker, rootStat] = await Promise.all([
      readFile(join(root, STORAGE_ROOT_MARKER_FILE), 'utf8'),
      stat(root, { bigint: true }),
    ]);
    const recorded = JSON.parse(marker) as { rootIdentity?: { dev?: unknown; ino?: unknown } };
    const identity = recorded.rootIdentity;
    if (typeof identity?.dev !== 'string' || typeof identity.ino !== 'string') return false;
    return identity.ino === rootStat.ino.toString() && identity.dev !== rootStat.dev.toString();
  } catch {
    return false;
  }
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

  const remounted = await onlyTheDeviceNumberMoved(path);
  const candidate = await prepareStorageRootIdentityRepair({
    path,
    kind: 'interactive',
  });
  if (!candidate) return resolveStorageRoot({ path, kind: 'interactive' });
  if (remounted) {
    console.log('[storage-root] the volume was mounted again; refreshing the recorded identity');
    return repairStorageRootIdentity(candidate);
  }
  if (!(await recovery.confirmRepair())) return undefined;
  return repairStorageRootIdentity(candidate);
}
