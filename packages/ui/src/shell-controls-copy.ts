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

import {
  defineUiCatalog,
  formatUiCopy,
  type UiCatalog,
  type UiLocale,
} from '@maka/core/ui-locale';
import { getUiCopyCatalog } from './ui-copy-catalog.js';

type ShellControlsResource = {
  shared: {
    close: string;
  };
  navigation: {
    mainLabel: string;
    newTask: string;
    automations: string;
    extensions: string;
    settings: string;
    buildStamp: string;
    updateDownloaded: string;
    updateFailed: string;
    pendingTasks: string;
  };
  search: {
    title: string;
    conversationsLabel: string;
    placeholder: string;
    clearLabel: string;
    statusRegionLabel: string;
    unavailable: string;
    privacyTitle: string;
    privacyDetail: string;
    errorTitle: string;
    errorFallback: string;
    introduction: string;
    searching: string;
    empty: string;
    results: {
      one: string;
      other: string;
    };
    truncatedResults: string;
    resultsLabel: string;
  };
};

type ShellControlsCopy = {
  shared: {
    close: string;
  };
  navigation: {
    mainLabel: string;
    newTask: string;
    automations: string;
    extensions: string;
    settings: string;
    /** Accessible name for the build stamp; the visible text is the stamp itself. */
    buildStamp: (stamp: string) => string;
    updateDownloaded(version: string): string;
    updateFailed(version: string): string;
    pendingTasks(count: number): string;
  };
  search: {
    title: string;
    conversationsLabel: string;
    placeholder: string;
    clearLabel: string;
    statusRegionLabel: string;
    unavailable: string;
    privacyTitle: string;
    privacyDetail: string;
    errorTitle: string;
    errorFallback: string;
    introduction: string;
    searching: string;
    empty: string;
    results(count: number): string;
    truncatedResults(count: number): string;
    resultsLabel: string;
  };
};

const SHELL_CONTROLS_RESOURCES = defineUiCatalog<ShellControlsResource>()(
  getUiCopyCatalog('shell-controls'),
);

const SHELL_CONTROLS_COPY_BY_LOCALE = {
  zh: materializeShellControlsCopy(SHELL_CONTROLS_RESOURCES.zh),
  en: materializeShellControlsCopy(SHELL_CONTROLS_RESOURCES.en),
} satisfies UiCatalog<ShellControlsCopy>;

export function getShellControlsCopy(locale: UiLocale): ShellControlsCopy {
  return SHELL_CONTROLS_COPY_BY_LOCALE[locale];
}

function materializeShellControlsCopy(resource: ShellControlsResource): ShellControlsCopy {
  return {
    shared: resource.shared,
    navigation: {
      ...resource.navigation,
      buildStamp: (stamp: string) => formatUiCopy(resource.navigation.buildStamp, { stamp }),
      updateDownloaded: (version: string) =>
        formatUiCopy(resource.navigation.updateDownloaded, { version }),
      updateFailed: (version: string) => formatUiCopy(resource.navigation.updateFailed, { version }),
      pendingTasks: (count: number) => formatUiCopy(resource.navigation.pendingTasks, { count }),
    },
    search: {
      ...resource.search,
      results: (count: number) =>
        formatUiCopy(count === 1 ? resource.search.results.one : resource.search.results.other, {
          count,
        }),
      truncatedResults: (count: number) =>
        formatUiCopy(resource.search.truncatedResults, { count }),
    },
  };
}
