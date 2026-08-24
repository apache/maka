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
