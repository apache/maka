/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import electronUpdater from 'electron-updater';
import type { AppUpdater, UpdateCheckResult } from 'electron-updater';
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
    }
  | { state: 'installing'; currentVersion: string; latestVersion: string }
  | {
      state: 'error';
      currentVersion: string;
      message: string;
      operation: 'check' | 'download' | 'install';
      latestVersion?: string;
    };

export type AppUpdateInstallRequest = {
  /** User consent from the trusted desktop renderer; this is a UX boundary, not a security boundary. */
  allowInterruptActiveTasks: boolean;
};

export type AppUpdateInstallResult =
  | { ok: true }
  | { ok: false; reason: 'active_tasks' }
  | { ok: false; reason: 'not_downloaded' | 'install_failed' };

export interface AppUpdateService {
  start(): void;
  dispose(): void;
  getStatus(): AppUpdateStatus;
  retryUpdateDownload(): Promise<AppUpdateStatus>;
  installUpdate(input: AppUpdateInstallRequest): Promise<AppUpdateInstallResult>;
  /** Check because the window regained focus, subject to a shared throttle. */
  checkForUpdatesOnFocus(): Promise<void>;
  /**
   * User-initiated check from Settings → About. Skips the focus throttle so
   * the button always runs a real check (or joins an in-flight one).
   */
  checkForUpdatesNow(): Promise<AppUpdateStatus>;
}

interface AppUpdateServiceDeps {
  currentVersion: string;
  isPackaged: boolean;
  updater?: AppUpdater;
  /**
   * Harness-only feed override (`MAKA_UPDATE_TEST_FEED`); see
   * {@link resolveUpdateFeedOverride} for the exact accepted shape.
   */
  testFeedUrl?: string;
  mockLatestVersion?: string;
  mockState?: 'available' | 'downloading' | 'downloaded';
  onStatusChange?: (status: AppUpdateStatus) => void;
  prepareInstall: (
    input: AppUpdateInstallRequest,
  ) => Promise<
    | { readonly kind: 'active_tasks' }
    | { readonly kind: 'prepared'; rollback(): void }
  >;
  clock?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
    /** Time source for the focus-check throttle. */
    now?(): number;
  };
}

const FIRST_UPDATE_CHECK_DELAY_MS = 10_000;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/**
 * Focus is a cheap, frequent signal, so it is throttled rather than trusted:
 * alt-tabbing ten times in a minute must not mean ten update requests. The
 * four-hour timer stays as the floor for a window that is never refocused.
 */
const UPDATE_CHECK_ON_FOCUS_MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Harness-only override for the update feed (`MAKA_UPDATE_TEST_FEED`).
 *
 * Accepts exactly `http://127.0.0.1:<port>[/path]` and maps it to a generic
 * provider so the end-to-end Windows auto-update verification can serve a
 * candidate installer plus `latest.yml` from a loopback HTTP server. Anything
 * else set — a remote host, `localhost`, another loopback alias, HTTPS,
 * userinfo, a query string, or a malformed URL — throws: a mistyped override
 * must never silently fall back to the production GitHub feed, because a test
 * run quietly installing a real release is exactly the failure this shape
 * exists to prevent.
 *
 * Security posture (this is not an update-hijack vector): setting an
 * environment variable on the app's process already requires code execution
 * as the same user, and the per-user NSIS install model means that user can
 * rewrite the installation directory directly — the override grants no
 * capability across any privilege boundary. Loopback-only keeps even that
 * same-user surface minimal: the feed must be a process listening on this
 * machine. With the variable unset the feed configuration is byte-identical
 * to production, and update signature verification (once a certificate
 * exists) applies to overridden feeds exactly as it does to the GitHub feed —
 * nothing here relaxes it.
 */
export function resolveUpdateFeedOverride(
  raw: string | undefined,
): { provider: 'generic'; url: string } | undefined {
  if (raw === undefined || raw === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(
      `MAKA_UPDATE_TEST_FEED is not a URL: ${JSON.stringify(raw)}`,
    );
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError(
      'MAKA_UPDATE_TEST_FEED must be http://127.0.0.1:<port>[/path] ' +
        `(got ${JSON.stringify(raw)})`,
    );
  }
  return { provider: 'generic', url: url.toString() };
}

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
  };
}

export function createAppUpdateService(deps: AppUpdateServiceDeps): AppUpdateService {
  let status: AppUpdateStatus = { state: 'idle', currentVersion: deps.currentVersion };
  let latestInfo: UpdateInfo | undefined;
  let checkInFlight: Promise<AppUpdateStatus> | null = null;
  let activeDownload: {
    promise: Promise<string[]>;
    cancellationToken?: UpdateCheckResult['cancellationToken'];
    cancelledForRetry: boolean;
  } | undefined;
  let checkTimer: unknown;
  let installHandoff: { rollback(): void } | undefined;
  let started = false;
  let disposed = false;
  // Resolve Electron's singleton lazily so tests can inject an updater without
  // constructing electron-updater's AppAdapter in a plain Node process.
  const updater = deps.updater ?? electronUpdater.autoUpdater;
  const clock = deps.clock ?? {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const now = (): number => clock.now?.() ?? Date.now();
  // One record shared by both triggers. Keeping a separate timestamp per
  // trigger would let a focus check fire seconds after a scheduled one.
  let lastCheckStartedAt: number | undefined;

  const publish = (next: AppUpdateStatus): AppUpdateStatus => {
    status = next;
    deps.onStatusChange?.(next);
    return next;
  };
  const currentStatus = (): AppUpdateStatus => status;

  const latestVersion = () =>
    status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded' ||
    status.state === 'installing' || status.state === 'error'
      ? status.latestVersion
      : updateInfoVersion(latestInfo);

  const publishError = (
    operation: Extract<AppUpdateStatus, { state: 'error' }>['operation'],
    error: unknown,
  ): AppUpdateStatus => publish({
    state: 'error',
    currentVersion: deps.currentVersion,
    latestVersion: latestVersion(),
    operation,
    message: error instanceof Error ? error.message : String(error),
  });

  const rollbackInstallHandoff = (): void => {
    const handoff = installHandoff;
    installHandoff = undefined;
    handoff?.rollback();
  };

  const trackAutoDownload = (result: UpdateCheckResult | null): void => {
    if (!result?.downloadPromise) return;
    const tracked = {
      promise: result.downloadPromise,
      cancellationToken: result.cancellationToken,
      cancelledForRetry: false,
    };
    activeDownload = tracked;
    void tracked.promise
      .catch((error) => {
        if (
          activeDownload === tracked &&
          !tracked.cancelledForRetry &&
          status.state !== 'error'
        ) {
          publishError('download', error);
        }
      })
      .finally(() => {
        if (activeDownload === tracked) activeDownload = undefined;
      });
  };

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.logger = null;
  const testFeed = resolveUpdateFeedOverride(deps.testFeedUrl);
  // Production reads electron-builder's packaged app-update.yml. Only the
  // loopback harness replaces that single authority boundary.
  if (testFeed) updater.setFeedURL(testFeed);

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
    });
  });
  updater.on('error', (error) => {
    const operation = status.state === 'installing'
      ? 'install'
      : status.state === 'available' || status.state === 'downloading'
        ? 'download'
        : 'check';
    if (operation === 'install') rollbackInstallHandoff();
    publishError(operation, error);
  });

  async function checkForUpdates(allowDuringDownload = false): Promise<AppUpdateStatus> {
    if (deps.mockLatestVersion) {
      return publish(mockStatus(deps.currentVersion, deps.mockLatestVersion, deps.mockState ?? 'downloading'));
    }
    if (!deps.isPackaged) {
      return publish({ state: 'not-available', currentVersion: deps.currentVersion });
    }
    if (status.state === 'downloaded' || status.state === 'installing') return status;
    if (status.state === 'downloading' && !allowDuringDownload) return status;
    if (activeDownload && !allowDuringDownload) return status;
    if (checkInFlight) return checkInFlight;
    lastCheckStartedAt = now();
    checkInFlight = updater
      .checkForUpdates()
      .then((result) => {
        trackAutoDownload(result);
        return status;
      })
      .catch((error) => status.state === 'error' ? status : publishError('check', error))
      .finally(() => {
        checkInFlight = null;
      });
    return checkInFlight;
  }

  const scheduleCheck = (delayMs: number): void => {
    if (disposed) return;
    checkTimer = clock.setTimeout(() => {
      checkTimer = undefined;
      void checkForUpdates().finally(() => {
        scheduleCheck(UPDATE_CHECK_INTERVAL_MS);
      });
    }, delayMs);
  };

  function start(): void {
    if (started || disposed) return;
    started = true;
    if (!deps.isPackaged && !deps.mockLatestVersion) return;
    scheduleCheck(FIRST_UPDATE_CHECK_DELAY_MS);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (checkTimer !== undefined) {
      clock.clearTimeout(checkTimer);
      checkTimer = undefined;
    }
  }

  async function retryUpdateDownload(): Promise<AppUpdateStatus> {
    if (deps.mockLatestVersion) {
      return publish(mockStatus(deps.currentVersion, deps.mockLatestVersion, 'downloaded'));
    }
    if (!deps.isPackaged || status.state === 'downloaded' || status.state === 'installing') {
      return status;
    }
    if (checkInFlight) await checkInFlight;
    const download = activeDownload;
    if (download) {
      download.cancelledForRetry = true;
      download.cancellationToken?.cancel();
      await download.promise.catch(() => undefined);
      const settled = currentStatus();
      if (settled.state === 'downloaded' || settled.state === 'installing') return settled;
    }
    return checkForUpdates(true);
  }

  async function installUpdate(input: AppUpdateInstallRequest): Promise<AppUpdateInstallResult> {
    if (status.state !== 'downloaded') return { ok: false, reason: 'not_downloaded' };
    if (deps.mockLatestVersion) {
      return { ok: true };
    }
    try {
      const preparation = await deps.prepareInstall(input);
      if (preparation.kind === 'active_tasks') {
        return { ok: false, reason: 'active_tasks' };
      }
      installHandoff = preparation;
      const version = latestVersion() ?? deps.currentVersion;
      publish({ state: 'installing', currentVersion: deps.currentVersion, latestVersion: version });
      updater.quitAndInstall(false, true);
      const installStatus = currentStatus();
      if (installStatus.state === 'error' && installStatus.operation === 'install') {
        return { ok: false, reason: 'install_failed' };
      }
      return { ok: true };
    } catch (error) {
      rollbackInstallHandoff();
      publishError('install', error);
      return { ok: false, reason: 'install_failed' };
    }
  }

  /**
   * Check because the user came back to the window.
   *
   * The four-hour timer alone means a version published while the app sat
   * open is not noticed until the next tick — which is what "the update did
   * not show up" actually was. Focus is when the user is present and a restart
   * prompt is least disruptive, so it is the right moment to look.
   *
   * Deliberately does NOT reset the scheduled timer: the two triggers stay
   * independent and the shared throttle is what keeps them from doubling up.
   */
  async function checkForUpdatesOnFocus(): Promise<void> {
    if (disposed || !started) return;
    if (
      lastCheckStartedAt !== undefined &&
      now() - lastCheckStartedAt < UPDATE_CHECK_ON_FOCUS_MIN_INTERVAL_MS
    ) {
      return;
    }
    // No `allowDuringDownload`: a download already in flight is the update
    // arriving, and re-checking mid-download is exactly what that guard exists
    // to prevent.
    await checkForUpdates();
  }

  async function checkForUpdatesNow(): Promise<AppUpdateStatus> {
    if (disposed) return currentStatus();
    // Explicit user action: always attempt (or join) a check; do not apply the
    // focus throttle. Still refuses to restart a mid-flight download.
    return checkForUpdates();
  }

  return {
    start,
    dispose,
    getStatus: currentStatus,
    retryUpdateDownload,
    installUpdate,
    checkForUpdatesOnFocus,
    checkForUpdatesNow,
  };
}
