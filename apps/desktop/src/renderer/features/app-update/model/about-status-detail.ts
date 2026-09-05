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

import type { AppUpdateStatus } from '../ports.js';

/**
 * The About-page copy the status line reads. Structural on purpose: the
 * feature owns updater state, not Settings copy, so it names only the keys it
 * needs and the Settings catalog satisfies it without an import edge.
 */
export interface AboutUpdateStatusCopy {
  readonly updateIdle: string;
  readonly checkingForUpdates: string;
  readonly updateNotAvailable: string;
  readonly updateAvailable: (version: string) => string;
  readonly updateDownloading: (version: string, percent: number) => string;
  readonly updateVerifying: (version: string) => string;
  readonly updateDownloaded: (version: string) => string;
  readonly updateInstalling: (version: string) => string;
  readonly updateCheckFailedDetail: (message: string) => string;
}

/**
 * Map updater state to About-page detail copy (pure for unit tests).
 *
 * There is no dev-build branch: a dev checkout renders no status line at all,
 * so the "development builds do not check GitHub releases" sentence this used
 * to return would only have restated the channel sentence above it. Whether
 * the line exists is the About page's decision; this only says what it reads.
 * `errorDetail` lets the page localize a raw updater error before it is shown.
 */
export function aboutUpdateStatusDetail(
  status: AppUpdateStatus | null,
  copy: AboutUpdateStatusCopy,
  options: { readonly errorDetail?: (message: string) => string } = {},
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
  return copy.updateCheckFailedDetail(
    options.errorDetail ? options.errorDetail(status.message) : status.message,
  );
}
