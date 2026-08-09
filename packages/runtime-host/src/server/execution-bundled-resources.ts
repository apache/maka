export interface ExecutionBundledResourceProcessIdentity {
  readonly electronVersion?: string;
  readonly defaultApp?: boolean;
  readonly resourcesPath?: string;
}

/**
 * Only a packaged Electron executable owns the release resource directory.
 * Node/CLI and development Electron candidates must not reinterpret ambient
 * directories as signed bundled-runtime authority.
 */
export function resolveExecutionBundledResourcesRoot(
  identity: ExecutionBundledResourceProcessIdentity,
): string | undefined {
  if (!identity.electronVersion || identity.defaultApp === true) return undefined;
  return typeof identity.resourcesPath === 'string' && identity.resourcesPath.length > 0
    ? identity.resourcesPath
    : undefined;
}
