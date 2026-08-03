import type {
  AppUpdateInstallRequest,
  AppUpdateInstallResult,
  AppUpdateStatus,
} from '../preload/bridge-contract.js';

export type AppUpdateInstallOutcome =
  | { kind: 'install-started' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: 'not_downloaded' | 'install_failed' };

export function isAppUpdateInstallFailure(
  status: AppUpdateStatus | null,
): status is Extract<AppUpdateStatus, { state: 'error' }> {
  return status?.state === 'error' && status.operation === 'install';
}

export async function requestDownloadedAppUpdate(input: {
  installUpdate(request: AppUpdateInstallRequest): Promise<AppUpdateInstallResult>;
  confirmActiveTasks(): Promise<boolean>;
}): Promise<AppUpdateInstallOutcome> {
  const guarded = await input.installUpdate({ allowInterruptActiveTasks: false });
  if (guarded.ok) return { kind: 'install-started' };
  if (guarded.reason !== 'active_tasks') return { kind: 'failed', reason: guarded.reason };
  if (!await input.confirmActiveTasks()) return { kind: 'cancelled' };

  const authorized = await input.installUpdate({ allowInterruptActiveTasks: true });
  return authorized.ok
    ? { kind: 'install-started' }
    : { kind: 'failed', reason: authorized.reason === 'active_tasks' ? 'install_failed' : authorized.reason };
}
