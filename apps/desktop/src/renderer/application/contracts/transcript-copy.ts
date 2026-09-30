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
import { classifiedErrorFallback } from './operation-diagnostics.js';
import { getDesktopConversationCopy } from './conversation-copy.js';
const COPY = {
  'zh-CN': { read: '任务内容暂时无法读取，请稍后重试。', refresh: '任务内容暂时无法刷新，请稍后重试。', refreshTitle: '刷新任务失败' },
  'zh-TW': { read: '任務內容暫時無法讀取，請稍後重試。', refresh: '任務內容暫時無法重新整理，請稍後重試。', refreshTitle: '重新整理任務失敗' },
  en: { read: 'Task content is temporarily unavailable. Try again later.', refresh: 'Task content could not be refreshed. Try again later.', refreshTitle: 'Could not refresh task' },
} satisfies UiCatalog<{ read: string; refresh: string; refreshTitle: string }>;
export function transcriptErrorMessage(error: unknown, locale: UiLocale, kind: 'read' | 'refresh' | 'restore'): string {
  if (kind === 'restore') {
    return classifiedErrorFallback(error, getDesktopConversationCopy(locale).actions.operationFailedFallback, locale, 'desktop');
  }
  return classifiedErrorFallback(error, COPY[locale][kind], locale, kind === 'read' ? 'message-read' : 'message-refresh');
}
export function transcriptRefreshTitle(locale: UiLocale): string { return COPY[locale].refreshTitle; }
