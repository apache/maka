import type { DesktopRuntimeHostRef } from '../preload/bridge-contract.js';

export type DefaultRuntimeHostDiagnosticTarget = { readonly profileId: string };

class DefaultRuntimeHostOperationError extends Error {
  readonly diagnosticTarget: DefaultRuntimeHostDiagnosticTarget;

  constructor(cause: unknown, diagnosticTarget: DefaultRuntimeHostDiagnosticTarget) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'Error';
    this.diagnosticTarget = diagnosticTarget;
  }
}

export async function runOnDefaultRuntimeHost<T>(
  operation: (host: DesktopRuntimeHostRef) => Promise<T>,
): Promise<{ readonly value: T; readonly diagnosticTarget: DefaultRuntimeHostDiagnosticTarget }> {
  const host = await window.maka.runtimeHostProfiles.getDefaultHost();
  const diagnosticTarget = { profileId: host.profileId };
  try {
    return { value: await operation(host), diagnosticTarget };
  } catch (error) {
    throw new DefaultRuntimeHostOperationError(error, diagnosticTarget);
  }
}

export function defaultRuntimeHostDiagnosticTarget(
  error: unknown,
): DefaultRuntimeHostDiagnosticTarget | undefined {
  return error instanceof DefaultRuntimeHostOperationError
    ? error.diagnosticTarget
    : undefined;
}
