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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import { classifyAppUpdateError, type AppUpdateErrorClass } from '@maka/core/app-update-error';

export interface AppUpdateCopy {
  readonly errors: Record<AppUpdateErrorClass, string>;
  readonly errorFallback: string;
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
    errors: {
      timeout: '更新请求超时',
      rate_limited: '更新服务请求过于频繁，请稍后重试。',
      auth_failed: '更新服务拒绝了访问，请检查网络或代理设置。',
      provider_error: '更新服务返回错误，请稍后重试。',
      network_error: '无法连接更新服务，请检查网络或代理设置。',
      release_unavailable: '当前无法获取此更新通道的版本信息，请稍后重试。',
      metadata_unavailable: '更新信息不可用，请稍后重试。',
    },
    errorFallback: '更新操作失败，请稍后重试。',
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
    errors: {
      timeout: '更新請求逾時',
      rate_limited: '更新服務請求過於頻繁，請稍後重試。',
      auth_failed: '更新服務拒絕了存取，請檢查網路或代理設定。',
      provider_error: '更新服務傳回錯誤，請稍後重試。',
      network_error: '無法連線至更新服務，請檢查網路或代理設定。',
      release_unavailable: '目前無法取得此更新通道的版本資訊，請稍後重試。',
      metadata_unavailable: '更新資訊無法使用，請稍後重試。',
    },
    errorFallback: '更新操作失敗，請稍後重試。',
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
    errors: {
      timeout: 'Update request timed out',
      rate_limited: 'Too many requests to the update service. Try again later.',
      auth_failed: 'The update service denied access. Check your network or proxy settings.',
      provider_error: 'The update service returned an error. Try again later.',
      network_error: 'Could not connect to the update service. Check your network or proxy settings.',
      release_unavailable: 'Version information for this update channel is currently unavailable. Try again later.',
      metadata_unavailable: 'Update information is unavailable. Try again later.',
    },
    errorFallback: 'Update failed. Try again later.',
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

export function appUpdateErrorMessage(error: unknown, locale: UiLocale): string {
  const copy = getAppUpdateCopy(locale);
  const classified = classifyAppUpdateError(error);
  return classified ? copy.errors[classified] : copy.errorFallback;
}
