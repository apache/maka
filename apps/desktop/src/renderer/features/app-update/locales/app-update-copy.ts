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

import { generalizedErrorMessageForLocale } from '@maka/core/redaction';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export interface AppUpdateCopy {
  readonly installFailedTitle: string;
  readonly installFailedFallback: string;
  readonly installManualFallback: string;
  readonly activeTasksTitle: string;
  readonly activeTasksDescription: string;
  readonly activeTasksConfirm: string;
  readonly activeTasksCancel: string;
  readonly retryFailedTitle: string;
  readonly retryFailedFallback: string;
}

const COPY_BY_LOCALE = {
  'zh-CN': {
    installFailedTitle: '无法安装更新',
    installFailedFallback: '请稍后重试。',
    installManualFallback: '请稍后重试，或手动下载最新版本。',
    activeTasksTitle: '仍有任务正在运行',
    activeTasksDescription: '仍有任务正在运行。更新会中断这些任务，是否继续？',
    activeTasksConfirm: '仍然更新',
    activeTasksCancel: '取消',
    retryFailedTitle: '无法重新下载更新',
    retryFailedFallback: '请稍后重试，或手动下载最新版本。',
  },
  'zh-TW': {
    installFailedTitle: '無法安裝更新',
    installFailedFallback: '請稍後重試。',
    installManualFallback: '請稍後重試，或手動下載最新版本。',
    activeTasksTitle: '仍有任務正在執行',
    activeTasksDescription: '仍有任務正在執行。更新會中斷這些任務，是否繼續？',
    activeTasksConfirm: '仍然更新',
    activeTasksCancel: '取消',
    retryFailedTitle: '無法重新下載更新',
    retryFailedFallback: '請稍後重試，或手動下載最新版本。',
  },
  en: {
    installFailedTitle: 'Could not install update',
    installFailedFallback: 'Try again later.',
    installManualFallback: 'Try again later, or download the latest version manually.',
    activeTasksTitle: 'Tasks are still running',
    activeTasksDescription: 'Tasks are still running. Updating will interrupt them. Continue?',
    activeTasksConfirm: 'Update anyway',
    activeTasksCancel: 'Cancel',
    retryFailedTitle: 'Could not retry update download',
    retryFailedFallback: 'Try again later, or download the latest version manually.',
  },
} satisfies UiCatalog<AppUpdateCopy>;

export function getAppUpdateCopy(locale: UiLocale): AppUpdateCopy {
  return COPY_BY_LOCALE[locale];
}

export function localizedAppUpdateErrorMessage(
  error: unknown,
  fallback: string,
  locale: UiLocale,
): string {
  return generalizedErrorMessageForLocale(error, fallback, locale);
}
