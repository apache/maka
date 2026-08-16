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
 * Consumes a resource root delegated by the direct Desktop parent. The outer
 * signed application/update chain is the provenance trust root; PID, fd and
 * path equality only bind this candidate to that parent and are not a defense
 * against a malicious same-user process that launches its own Electron tree.
 * Node/CLI callers cannot reinterpret an ambient pathname as this delegation.
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
