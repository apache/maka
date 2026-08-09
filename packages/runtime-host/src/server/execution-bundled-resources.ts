export interface ExecutionBundledResourceProcessIdentity {
  readonly electronVersion?: string;
  readonly defaultApp?: boolean;
  readonly resourcesPath?: string;
  readonly parentPid?: number;
}

export interface ExecutionBundledResourceBootstrap {
  readonly kind: 'maka_packaged_candidate_bootstrap_v1';
  readonly parentPid: number;
  readonly resourcesRoot: string;
}

/**
 * Only a packaged Electron executable owns the release resource directory.
 * Node/CLI and development Electron candidates must not reinterpret ambient
 * directories as signed bundled-runtime authority.
 */
export function resolveExecutionBundledResourcesRoot(
  identity: ExecutionBundledResourceProcessIdentity,
  bootstrap?: ExecutionBundledResourceBootstrap,
): string | undefined {
  if (!identity.electronVersion || identity.defaultApp === true || !bootstrap) {
    return undefined;
  }
  if (
    !identity.resourcesPath ||
    identity.resourcesPath !== bootstrap.resourcesRoot ||
    identity.parentPid !== bootstrap.parentPid
  ) {
    throw new Error('Packaged resource authority does not match the Electron resource root');
  }
  return identity.resourcesPath;
}
