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
  let maxInterruptibleActiveTasks = 0;
  for (;;) {
    const result = await input.installUpdate({ maxInterruptibleActiveTasks });
    if (result.ok) return { kind: 'install-started' };
    if (result.reason !== 'active_tasks') return { kind: 'failed', reason: result.reason };
    if (result.activeTaskCount <= maxInterruptibleActiveTasks) {
      return { kind: 'failed', reason: 'install_failed' };
    }

    const confirmed = await input.confirmActiveTasks(result.activeTaskCount);
    if (!confirmed) return { kind: 'cancelled' };
    maxInterruptibleActiveTasks = result.activeTaskCount;
  }
}
