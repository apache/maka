export interface ExecutionBundledResourceProcessIdentity {
  readonly electronVersion?: string;
  readonly defaultApp?: boolean;
  readonly resourcesPath?: string;
  /** Explicit authority forwarded by an app.isPackaged Desktop parent. */
  readonly parentAuthorizedResourcesRoot?: string;
}

/**
 * Only a packaged Electron executable owns the release resource directory.
 * Node/CLI and development Electron candidates must not reinterpret ambient
 * directories as signed bundled-runtime authority.
 */
export function resolveExecutionBundledResourcesRoot(
  identity: ExecutionBundledResourceProcessIdentity,
): string | undefined {
  if (
    !identity.electronVersion ||
    identity.defaultApp === true ||
    !identity.parentAuthorizedResourcesRoot
  ) {
    return undefined;
  }
  if (
    !identity.resourcesPath ||
    identity.resourcesPath !== identity.parentAuthorizedResourcesRoot
  ) {
    throw new Error('Packaged resource authority does not match the Electron resource root');
  }
  return identity.resourcesPath;
}
