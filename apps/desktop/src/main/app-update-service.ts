import electronUpdater from 'electron-updater';
import type { AppUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateInfo } from 'electron-updater';

export type AppUpdateProgress = {
  percent: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
};

export type AppUpdateStatus =
  | { state: 'idle'; currentVersion: string }
  | { state: 'checking'; currentVersion: string }
  | { state: 'not-available'; currentVersion: string; latestVersion?: string }
  | {
      state: 'available';
      currentVersion: string;
      latestVersion: string;
      releaseName?: string;
      releaseUrl?: string;
      publishedAt?: string;
    }
  | {
      state: 'downloading';
      currentVersion: string;
      latestVersion: string;
      progress: AppUpdateProgress;
    }
  | {
      state: 'downloaded';
      currentVersion: string;
      latestVersion: string;
      releaseName?: string;
      downloadedFile?: string;
    }
  | { state: 'error'; currentVersion: string; message: string; latestVersion?: string };

export interface AppUpdateService {
  getStatus(): AppUpdateStatus;
  checkForUpdates(): Promise<AppUpdateStatus>;
  downloadUpdate(): Promise<AppUpdateStatus>;
  installUpdate(): Promise<{ ok: true } | { ok: false; reason: 'not_downloaded' | 'install_failed' }>;
  openUpdateDownload(): Promise<{ ok: true } | { ok: false; reason: 'not_available' | 'open_failed' }>;
}

interface AppUpdateServiceDeps {
  currentVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  openExternal(url: string): Promise<void>;
  updater?: AppUpdater;
  mockLatestVersion?: string;
  mockState?: 'available' | 'downloading' | 'downloaded';
  onStatusChange?: (status: AppUpdateStatus) => void;
}

const RELEASES_URL = 'https://github.com/Maka-Agent/maka-agent/releases/latest';
const { autoUpdater } = electronUpdater;

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

function versionParts(version: string): number[] | null {
  const match = normalizeVersion(version).match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [
    Number(match[1] ?? 0),
    Number(match[2] ?? 0),
    Number(match[3] ?? 0),
  ];
}

function isVersionNewer(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const base = versionParts(current);
  if (!next || !base) return normalizeVersion(candidate) !== normalizeVersion(current);
  for (let index = 0; index < Math.max(next.length, base.length); index += 1) {
    const left = next[index] ?? 0;
    const right = base[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

function updateInfoVersion(info: Pick<UpdateInfo, 'version'> | undefined): string | undefined {
  return typeof info?.version === 'string' ? normalizeVersion(info.version) : undefined;
}

function updateInfoReleaseName(info: UpdateInfo | undefined): string | undefined {
  return typeof info?.releaseName === 'string' ? info.releaseName : undefined;
}

function updateInfoReleaseDate(info: UpdateInfo | undefined): string | undefined {
  return typeof info?.releaseDate === 'string' ? info.releaseDate : undefined;
}

function updateInfoReleaseUrl(info: UpdateInfo | undefined): string | undefined {
  const files = Array.isArray(info?.files) ? info.files : [];
  const firstUrl = files.find((file) => typeof file.url === 'string')?.url;
  return firstUrl ? new URL(firstUrl, RELEASES_URL).toString() : RELEASES_URL;
}

function progressFromInfo(info: ProgressInfo): AppUpdateProgress {
  return {
    percent: Math.max(0, Math.min(100, Number.isFinite(info.percent) ? info.percent : 0)),
    bytesPerSecond: Number.isFinite(info.bytesPerSecond) ? info.bytesPerSecond : undefined,
    transferred: Number.isFinite(info.transferred) ? info.transferred : undefined,
    total: Number.isFinite(info.total) ? info.total : undefined,
  };
}

function mockStatus(currentVersion: string, latestVersion: string, state: AppUpdateServiceDeps['mockState']): AppUpdateStatus {
  if (!isVersionNewer(latestVersion, currentVersion)) {
    return { state: 'not-available', currentVersion, latestVersion };
  }
  if (state === 'downloaded') {
    return {
      state: 'downloaded',
      currentVersion,
      latestVersion,
      releaseName: `Maka ${latestVersion}`,
      downloadedFile: 'mock-update.zip',
    };
  }
  if (state === 'downloading') {
    return {
      state: 'downloading',
      currentVersion,
      latestVersion,
      progress: { percent: 42, bytesPerSecond: 1_200_000, transferred: 42_000_000, total: 100_000_000 },
    };
  }
  return {
    state: 'available',
    currentVersion,
    latestVersion,
    releaseName: `Maka ${latestVersion}`,
    releaseUrl: RELEASES_URL,
    publishedAt: new Date().toISOString(),
  };
}

export function createAppUpdateService(deps: AppUpdateServiceDeps): AppUpdateService {
  let status: AppUpdateStatus = { state: 'idle', currentVersion: deps.currentVersion };
  let latestInfo: UpdateInfo | undefined;
  let checkInFlight: Promise<AppUpdateStatus> | null = null;
  let downloadInFlight: Promise<AppUpdateStatus> | null = null;
  const updater = deps.updater ?? autoUpdater;

  const publish = (next: AppUpdateStatus): AppUpdateStatus => {
    status = next;
    deps.onStatusChange?.(next);
    return next;
  };

  const latestVersion = () =>
    status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded' || status.state === 'error'
      ? status.latestVersion
      : updateInfoVersion(latestInfo);

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.logger = null;
  updater.setFeedURL({
    provider: 'github',
    owner: 'Maka-Agent',
    repo: 'maka-agent',
  });

  updater.on('checking-for-update', () => {
    publish({ state: 'checking', currentVersion: deps.currentVersion });
  });
  updater.on('update-available', (info) => {
    latestInfo = info;
    const version = updateInfoVersion(info) ?? deps.currentVersion;
    publish({
      state: 'available',
      currentVersion: deps.currentVersion,
      latestVersion: version,
      releaseName: updateInfoReleaseName(info),
      releaseUrl: updateInfoReleaseUrl(info),
      publishedAt: updateInfoReleaseDate(info),
    });
  });
  updater.on('update-not-available', (info) => {
    latestInfo = info;
    publish({
      state: 'not-available',
      currentVersion: deps.currentVersion,
      latestVersion: updateInfoVersion(info),
    });
  });
  updater.on('download-progress', (progress) => {
    const version = latestVersion() ?? deps.currentVersion;
    publish({
      state: 'downloading',
      currentVersion: deps.currentVersion,
      latestVersion: version,
      progress: progressFromInfo(progress),
    });
  });
  updater.on('update-downloaded', (event) => {
    latestInfo = event;
    publish({
      state: 'downloaded',
      currentVersion: deps.currentVersion,
      latestVersion: updateInfoVersion(event) ?? latestVersion() ?? deps.currentVersion,
      releaseName: updateInfoReleaseName(event),
      downloadedFile: event.downloadedFile,
    });
  });
  updater.on('error', (error) => {
    publish({
      state: 'error',
      currentVersion: deps.currentVersion,
      latestVersion: latestVersion(),
      message: error instanceof Error ? error.message : String(error),
    });
  });

  async function downloadUpdate(): Promise<AppUpdateStatus> {
    if (deps.mockLatestVersion) {
      return publish(mockStatus(deps.currentVersion, deps.mockLatestVersion, deps.mockState ?? 'downloaded'));
    }
    if (!deps.isPackaged) return status;
    if (status.state === 'downloaded') return status;
    if (downloadInFlight) return downloadInFlight;
    const version = latestVersion() ?? deps.currentVersion;
    publish({
      state: 'downloading',
      currentVersion: deps.currentVersion,
      latestVersion: version,
      progress: { percent: 0 },
    });
    downloadInFlight = updater
      .downloadUpdate()
      .then(() => status)
      .catch((error) => publish({
        state: 'error',
        currentVersion: deps.currentVersion,
        latestVersion: version,
        message: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        downloadInFlight = null;
      });
    return downloadInFlight;
  }

  async function checkForUpdates(): Promise<AppUpdateStatus> {
    if (deps.mockLatestVersion) {
      const next = mockStatus(deps.currentVersion, deps.mockLatestVersion, deps.mockState ?? 'downloading');
      publish(next);
      return next.state === 'available' ? downloadUpdate() : next;
    }
    if (!deps.isPackaged) {
      return publish({ state: 'not-available', currentVersion: deps.currentVersion });
    }
    if (status.state === 'downloaded' || status.state === 'downloading') return status;
    if (checkInFlight) return checkInFlight;
    checkInFlight = updater
      .checkForUpdates()
      .then(async (result) => {
        if (result?.isUpdateAvailable) return downloadUpdate();
        return status;
      })
      .catch((error) => publish({
        state: 'error',
        currentVersion: deps.currentVersion,
        latestVersion: latestVersion(),
        message: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        checkInFlight = null;
      });
    return checkInFlight;
  }

  async function installUpdate(): Promise<{ ok: true } | { ok: false; reason: 'not_downloaded' | 'install_failed' }> {
    if (deps.mockLatestVersion) {
      if (status.state !== 'downloaded') return { ok: false, reason: 'not_downloaded' };
      return { ok: true };
    }
    if (status.state !== 'downloaded') return { ok: false, reason: 'not_downloaded' };
    try {
      updater.quitAndInstall(false, true);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'install_failed' };
    }
  }

  async function openUpdateDownload(): Promise<{ ok: true } | { ok: false; reason: 'not_available' | 'open_failed' }> {
    const url = status.state === 'available' ? status.releaseUrl ?? RELEASES_URL : RELEASES_URL;
    if (status.state === 'not-available' || status.state === 'idle' || status.state === 'checking') {
      return { ok: false, reason: 'not_available' };
    }
    try {
      await deps.openExternal(url);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'open_failed' };
    }
  }

  return {
    getStatus: () => status,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    openUpdateDownload,
  };
}
