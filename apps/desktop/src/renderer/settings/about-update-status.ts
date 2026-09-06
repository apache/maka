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
  /** What the updater is doing or has found, as the row's label. */
  readonly label: string;
  /** Where to act or why it failed; null when the label says it all. */
  readonly description: string | null;
  /**
   * Whether the row offers 检查更新: `check` resting, `checking` while one runs,
   * `none` while the updater is working on its own or waiting for the restart
   * that the sidebar footer offers.
   */
  readonly action: 'check' | 'checking' | 'none';
}

/**
 * Map updater state to the About page's update row, pure for unit tests.
 *
 * The control follows the state instead of always reading 检查更新: the service
 * refuses a check while a download is in flight or an update sits downloaded
 * (app-update-service.ts), so a check button in those states was a control that
 * did nothing when pressed — which is exactly what a nightly user, whose steady
 * state is `downloaded`, met every time. A failed download is re-fetched by the
 * same check (the updater downloads on its own once it sees a release), so the
 * page needs no second retry control next to the sidebar's.
 */
export function aboutUpdateRow(
  status: AppUpdateStatus | null,
  copy: AboutCopy,
  options: { readonly errorDetail?: (message: string) => string } = {},
): AboutUpdateRow {
  if (!status || status.state === 'idle') {
    return { label: copy.updateIdle, description: null, action: 'check' };
  }
  switch (status.state) {
    case 'checking':
      return { label: copy.checkingForUpdates, description: null, action: 'checking' };
    case 'not-available':
      return { label: copy.updateNotAvailable, description: null, action: 'check' };
    case 'available':
      return { label: copy.updateAvailable(status.latestVersion), description: null, action: 'none' };
    case 'downloading':
      return {
        label: copy.updateDownloading(status.latestVersion, Math.round(status.progress.percent)),
        description: null,
        action: 'none',
      };
    case 'verifying':
      return { label: copy.updateVerifying(status.latestVersion), description: null, action: 'none' };
    case 'downloaded':
      return {
        label: copy.updateDownloaded(status.latestVersion),
        description: copy.updateDownloadedHint,
        action: 'none',
      };
    case 'installing':
      return { label: copy.updateInstalling(status.latestVersion), description: null, action: 'none' };
    case 'error':
      return {
        label: copy.updateFailed[status.operation],
        description: options.errorDetail ? options.errorDetail(status.message) : status.message,
        action: 'check',
      };
  }
}
