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
interface StorageRetentionCopy {
  title: string;
  help: string;
  enabled: string;
  days: string;
  refresh: string;
  loading: string;
  failed: string;
  dayOption: (days: number) => string;
  preview: (count: number, date: string) => string;
  disabled: string;
  cleanup: (count: number, size: string, date: string) => string;
  unknownBytes: string;
  needsReview: (count: number) => string;
}

const COPY = {
  en: {
    title: 'Automatic cleanup on this Host',
    help: 'Applies to all archived tasks on this Host. The clock starts when enabled or the duration changes. Pinned tasks are kept.',
    enabled: 'Delete archived tasks automatically', days: 'Delete after', refresh: 'Refresh',
    loading: 'Loading retention settings…', failed: 'Could not load or save retention settings. Refresh before trying again.',
    dayOption: (days: number) => `${days} days`,
    preview: (count: number, date: string) => `${count} archived tasks become eligible on ${date}.`,
    disabled: 'Automatic deletion is off.',
    cleanup: (count: number, size: string, date: string) => `Last automatic cleanup: deleted ${count} tasks (${size}) on ${date}.`,
    unknownBytes: 'size unavailable', needsReview: (count: number) => `${count} tasks need manual review.`,
  },
  'zh-CN': {
    title: '此 Host 的自动清理', help: '适用于此 Host 的所有已归档任务。启用或修改天数时重新计时，已置顶任务会保留。',
    enabled: '自动删除已归档任务', days: '保留时长', refresh: '刷新', loading: '正在读取自动清理设置…', failed: '无法读取或保存设置，请刷新后重试。',
    dayOption: (days: number) => `${days} 天`, preview: (count: number, date: string) => `${count} 个已归档任务将在 ${date} 后符合清理条件。`,
    disabled: '自动删除已关闭。', cleanup: (count: number, size: string, date: string) => `上次自动清理：${date} 删除了 ${count} 个任务（${size}）。`,
    unknownBytes: '大小未知', needsReview: (count: number) => `${count} 个任务需要手动检查。`,
  },
  'zh-TW': {
    title: '此 Host 的自動清理', help: '適用於此 Host 的所有已封存任務。啟用或修改天數時重新計時，已置頂任務會保留。',
    enabled: '自動刪除已封存任務', days: '保留時長', refresh: '重新整理', loading: '正在讀取自動清理設定…', failed: '無法讀取或儲存設定，請重新整理後重試。',
    dayOption: (days: number) => `${days} 天`, preview: (count: number, date: string) => `${count} 個已封存任務將在 ${date} 後符合清理條件。`,
    disabled: '自動刪除已關閉。', cleanup: (count: number, size: string, date: string) => `上次自動清理：${date} 刪除了 ${count} 個任務（${size}）。`,
    unknownBytes: '大小未知', needsReview: (count: number) => `${count} 個任務需要手動檢查。`,
  },
} satisfies UiCatalog<StorageRetentionCopy>;
export function getStorageRetentionCopy(locale: UiLocale) { return COPY[locale]; }
