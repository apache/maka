import type {
  AppUpdateInstallRequest,
  AppUpdateInstallResult,
} from '../preload/bridge-contract.js';

export type AppUpdateInstallOutcome =
  | { kind: 'install-started' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: 'not_downloaded' | 'install_failed' };

export async function requestDownloadedAppUpdate(input: {
  installUpdate(request: AppUpdateInstallRequest): Promise<AppUpdateInstallResult>;
  confirmActiveTasks(activeTaskCount: number): Promise<boolean>;
}): Promise<AppUpdateInstallOutcome> {
  const initial = await input.installUpdate({ allowInterruptActiveTasks: false });
  if (initial.ok) return { kind: 'install-started' };
  if (initial.reason !== 'active_tasks') return { kind: 'failed', reason: initial.reason };

  const confirmed = await input.confirmActiveTasks(initial.activeTaskCount);
  if (!confirmed) return { kind: 'cancelled' };

  const authorized = await input.installUpdate({ allowInterruptActiveTasks: true });
  if (authorized.ok) return { kind: 'install-started' };
  return {
    kind: 'failed',
    reason: authorized.reason === 'active_tasks' ? 'install_failed' : authorized.reason,
  };
}
