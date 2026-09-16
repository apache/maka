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

import type { AppUpdateStatus, DesktopAppInfo } from '../../preload/bridge-contract.js';
import type { SettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';

type AboutCopy = SettingsPreferencesCopy['about'];

/**
 * The one sentence the About lead says about this build's channel, pure for
 * unit tests.
 *
 * Build mode and release channel answer different questions: `buildMode` says
 * how this binary was produced (a checkout vs a packaged install), while
 * `updateChannel` says which release feed it follows. A dev checkout follows no
 * feed at all — its `updateChannel` is the updater's `release` placeholder — so
 * `buildMode` decides first, and the old "packaged → 正式版" mapping that lied
 * to nightly users stays gone.
 */
export function aboutChannelSummary(
  info: Pick<DesktopAppInfo, 'buildMode' | 'updateChannel'>,
  copy: AboutCopy,
): string {
  return copy.channelSummaries[info.buildMode === 'dev' ? 'dev' : info.updateChannel];
}

export interface AboutUpdateRow {
  /** The phase, a few words: the label never truncates against the button. */
  readonly label: string;
  /** The version and what happens next, or why it failed. Always present, so the row keeps its height across states. */
  readonly description: string;
  /**
   * The row's one control, always present so the row keeps its shape:
   * 检查更新 (`check` resting, `checking` while one runs, `busy` disabled while
   * the updater is working on its own) or the restart once an update is
   * downloaded (`install`).
   */
  readonly action: 'check' | 'checking' | 'busy' | 'install';
}

/**
 * Map updater state to the About page's update row, pure for unit tests.
 *
 * The service refuses a check while a download is in flight or an update sits
 * downloaded (app-update-service.ts), so 检查更新 is disabled rather than
 * offered there. A failed download is re-fetched by the same check (the updater
 * downloads on its own once it sees a release), so the page needs no second
 * retry control next to the sidebar's.
 */
export function aboutUpdateRow(
  status: AppUpdateStatus | null,
  copy: AboutCopy,
  options: { readonly errorDetail?: (message: string) => string } = {},
): AboutUpdateRow {
  if (!status || status.state === 'idle') {
    return { label: copy.updateIdle, description: copy.updateScheduleHint, action: 'check' };
  }
  switch (status.state) {
    case 'checking':
      return { label: copy.checkingForUpdates, description: copy.updateScheduleHint, action: 'checking' };
    case 'not-available':
      return { label: copy.updateNotAvailable, description: copy.updateScheduleHint, action: 'check' };
    case 'available':
      return {
        label: copy.updateAvailable,
        description: copy.updateFetchingHint(status.latestVersion),
        action: 'busy',
      };
    case 'downloading':
      return {
        label: copy.updateDownloading(Math.round(status.progress.percent)),
        description: copy.updateFetchingHint(status.latestVersion),
        action: 'busy',
      };
    case 'verifying':
      return {
        label: copy.updateVerifying,
        description: copy.updateFetchingHint(status.latestVersion),
        action: 'busy',
      };
    case 'downloaded':
      return {
        label: copy.updateDownloaded,
        description: copy.updateDownloadedHint(status.latestVersion),
        action: 'install',
      };
    case 'installing':
      return {
        label: copy.updateInstalling,
        description: copy.updateInstallingHint(status.latestVersion),
        action: 'busy',
      };
    case 'error':
      return {
        label: copy.updateFailed[status.operation],
        description: options.errorDetail ? options.errorDetail(status.message) : status.message,
        action: 'check',
      };
  }
}
