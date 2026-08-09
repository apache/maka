import { realpath } from 'node:fs/promises';

const authorityRoots = new WeakMap<object, string>();

export interface DesktopPackagedCandidateAuthority {
  readonly kind: 'desktop_packaged_candidate_authority_v1';
}

/**
 * Issues a process-local capability only from the real packaged Electron main
 * process. Callers cannot turn a pathname or CLI argument into this authority.
 */
export async function issueDesktopPackagedCandidateAuthority(): Promise<
  DesktopPackagedCandidateAuthority | undefined
> {
  if (!process.versions.electron || !process.resourcesPath) return undefined;
  const electron = await import('electron');
  if (!electron.app?.isPackaged) return undefined;
  const authority = Object.freeze({
    kind: 'desktop_packaged_candidate_authority_v1' as const,
  });
  authorityRoots.set(authority, await realpath(process.resourcesPath));
  return authority;
}

export function requireDesktopPackagedCandidateAuthority(
  authority: DesktopPackagedCandidateAuthority,
): string {
  const resourcesRoot = authorityRoots.get(authority);
  if (!resourcesRoot) throw new Error('Invalid Desktop packaged candidate authority');
  return resourcesRoot;
}
