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

/** The channel pill's Astryx Badge variant, narrow enough to assign directly. */
export type AboutChannelBadgeVariant = 'neutral' | 'blue' | 'orange';

export interface AboutChannelBadge {
  readonly label: string;
  readonly variant: AboutChannelBadgeVariant;
  /** The bare channel name without the dev commit suffix — for readouts that
   *  already sit next to the version pill and don't need it repeated. */
  readonly channelName: string;
}

/**
 * What the version pill next to "Maka" actually says, pure for unit tests.
 *
 * Build mode and release channel answer different questions: `buildMode` says
 * how this binary was produced (a checkout vs a packaged install), while
 * `updateChannel` says which release feed it follows. A packaged nightly is a
 * real install but NOT a release, so the old "packaged → 正式版" mapping lied
 * to exactly the users running nightly builds. Dev mode keeps the commit in
 * the label and drops to `neutral`: a checkout is not a release artifact
 * either, so it must not wear the release blue.
 */
export function aboutChannelBadge(
  info: Pick<DesktopAppInfo, 'buildMode' | 'buildCommit' | 'updateChannel'>,
  copy: AboutCopy,
): AboutChannelBadge {
  if (info.buildMode === 'dev') {
    return {
      label: info.buildCommit ? `${copy.devBuild} · ${info.buildCommit}` : copy.devBuild,
      variant: 'neutral',
      channelName: copy.devBuild,
    };
  }
  if (info.updateChannel === 'nightly') {
    return { label: copy.nightlyBuild, variant: 'orange', channelName: copy.nightlyBuild };
  }
  return { label: copy.packagedBuild, variant: 'blue', channelName: copy.packagedBuild };
}

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
  if (status.state === 'verifying') return copy.updateVerifying(status.latestVersion);
  if (status.state === 'downloaded') return copy.updateDownloaded(status.latestVersion);
  if (status.state === 'installing') return copy.updateInstalling(status.latestVersion);
  return copy.updateCheckFailedDetail(status.message);
}
