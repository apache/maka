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

export interface AboutChannelFacts {
  /** One sentence saying what following this channel means. */
  readonly summary: string;
  /**
   * The lead `Token`, or null. A release install is the default state and gets
   * no mark: Astryx reserves colour for what departs from it, so tokening every
   * channel would make none of them stand out — which is also why the release
   * channel now has no name string anywhere in the product.
   */
  readonly token: { readonly label: string; readonly color: 'orange' | 'gray' } | null;
}

/**
 * What the About lead says about this build's channel, pure for unit tests.
 *
 * Build mode and release channel answer different questions: `buildMode` says
 * how this binary was produced (a checkout vs a packaged install), while
 * `updateChannel` says which release feed it follows. A dev checkout follows no
 * feed at all — its `updateChannel` is the updater's `release` placeholder — so
 * `buildMode` decides first, and the old "packaged → 正式版" mapping that lied
 * to nightly users stays gone.
 */
export function aboutChannelFacts(
  info: Pick<DesktopAppInfo, 'buildMode' | 'updateChannel'>,
  copy: AboutCopy,
): AboutChannelFacts {
  const key = info.buildMode === 'dev' ? 'dev' : info.updateChannel;
  return {
    summary: copy.channelSummaries[key],
    token: key === 'nightly'
      ? { label: copy.nightlyBuild, color: 'orange' }
      : key === 'dev'
        ? { label: copy.devBuild, color: 'gray' }
        : null,
  };
}

/**
 * Map updater state to About-page detail copy (pure for unit tests).
 *
 * There is no dev-build branch: a dev checkout renders no status line at all,
 * so the "development builds do not check GitHub releases" sentence this used
 * to return would only have restated the channel sentence above it.
 */
export function aboutUpdateStatusDetail(
  status: AppUpdateStatus | null,
  copy: AboutCopy,
): string {
  if (!status || status.state === 'idle') return copy.updateIdle;
  if (status.state === 'checking') return copy.checkingForUpdates;
  if (status.state === 'not-available') return copy.updateNotAvailable;
  if (status.state === 'available') return copy.updateAvailable(status.latestVersion);
  if (status.state === 'downloading') {
    return copy.updateDownloading(status.latestVersion, Math.round(status.progress.percent));
  }
  if (status.state === 'verifying') return copy.updateVerifying(status.latestVersion);
  if (status.state === 'downloaded') return copy.updateDownloaded(status.latestVersion);
  if (status.state === 'installing') return copy.updateInstalling(status.latestVersion);
  return copy.updateCheckFailedDetail(status.message);
}
