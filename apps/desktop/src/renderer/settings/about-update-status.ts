import type { AppUpdateStatus } from '../../preload/bridge-contract.js';
import type { SettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';

type AboutCopy = SettingsPreferencesCopy['about'];

/** Map updater state to About-page detail copy (pure for unit tests). */
export function aboutUpdateStatusDetail(
  status: AppUpdateStatus | null,
  copy: AboutCopy,
  options: { readonly isDevBuild: boolean },
): string {
  if (options.isDevBuild) return copy.updateDevBuildHelp;
  if (!status || status.state === 'idle') return copy.updateIdle;
  if (status.state === 'checking') return copy.checkingForUpdates;
  if (status.state === 'not-available') return copy.updateNotAvailable;
  if (status.state === 'available') return copy.updateAvailable(status.latestVersion);
  if (status.state === 'downloading') {
    return copy.updateDownloading(status.latestVersion, Math.round(status.progress.percent));
  }
  if (status.state === 'downloaded') return copy.updateDownloaded(status.latestVersion);
  if (status.state === 'installing') return copy.updateInstalling(status.latestVersion);
  return copy.updateCheckFailedDetail(status.message);
}
