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

import type { DesktopAppInfo } from '../../preload/bridge-contract.js';
import type { SettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';

type AboutCopy = SettingsPreferencesCopy['about'];

// Only channel facts live here. The status line's copy mapping,
// `aboutUpdateStatusDetail`, moved to the App Update feature
// (features/app-update/model/about-status-detail.ts) because it reads updater
// state, which that feature owns; channel facts stay because they are About
// copy about the install itself, not update state.

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
