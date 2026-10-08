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
import type { StorageUsageKind } from '@maka/runtime-host/protocol';

export type StorageUsageCopy = {
  title: string;
  help: string;
  loading: string;
  loadFailed: string;
  refresh: string;
  total: string;
  totalDetail: string;
  /** Every kind the Host can report, so a new kind cannot render unlabeled. */
  kinds: Record<StorageUsageKind, { label: string; detail: string }>;
  reclaimable: string;
  reclaimableDetail: string;
  worktrees: string;
  worktreesDetail: string;
  worktreeCount(count: number): string;
  /** Prefix for an estimate rather than bytes on disk. */
  approximately(size: string): string;
  /** Label for a task's size in the archived-task list. */
  taskSize(size: string): string;
  /** Caveats under the archived-task list, which shows per-task sizes. */
  taskSizeNote: string;
};

const STORAGE_USAGE_COPY = {
  'zh-CN': {
    title: '存储占用',
    help: '当前运行时主机的数据占用。此处只读，不会删除或压缩任何内容。',
    loading: '正在统计…',
    loadFailed: '无法统计存储占用',
    refresh: '重新统计',
    total: '合计',
    totalDetail: '下列各项之和。标注 ≈ 的是按记录估算的大小，可能与其他项略有重叠。',
    kinds: {
      database: {
        label: '任务数据库',
        detail: '任务的对话、运行日志、用量历史和索引。用量历史在删除任务后仍会保留，以保证用量统计完整。',
      },
      artifacts: { label: '产物文件', detail: '任务生成或导入的文件，按记录的文件大小统计。' },
      context_offload: {
        label: '卸载的上下文',
        detail: '为节省上下文而移出的长内容，相同内容只保存一份。',
      },
      memory: { label: '长期记忆', detail: '跨任务保留的记忆条目。' },
    },
    reclaimable: '可回收空间',
    reclaimableDetail: '任务数据库中已释放但尚未归还磁盘的空间，已计入「任务数据库」。',
    worktrees: '子代理工作树',
    worktreesDetail: '只统计数量；每个工作树的大小取决于对应项目的检出内容。',
    worktreeCount: (count: number) => `${count} 个`,
    approximately: (size: string) => `≈ ${size}`,
    taskSize: (size: string) => `占用 ${size}`,
    taskSizeNote:
      '任务占用为估算值。卸载的上下文按任务引用计算，多个任务共享的内容会重复计入；删除任务后用量历史仍会保留。',
  },
  'zh-TW': {
    title: '儲存空間占用',
    help: '目前執行階段主機的資料占用。此處唯讀，不會刪除或壓縮任何內容。',
    loading: '正在統計…',
    loadFailed: '無法統計儲存空間占用',
    refresh: '重新統計',
    total: '合計',
    totalDetail: '下列各項之和。標註 ≈ 的是依記錄估算的大小，可能與其他項略有重疊。',
    kinds: {
      database: {
        label: '任務資料庫',
        detail: '任務的對話、執行日誌、用量歷史和索引。用量歷史在刪除任務後仍會保留，以確保用量統計完整。',
      },
      artifacts: { label: '產物檔案', detail: '任務生成或匯入的檔案，依記錄的檔案大小統計。' },
      context_offload: {
        label: '卸載的上下文',
        detail: '為節省上下文而移出的長內容，相同內容只儲存一份。',
      },
      memory: { label: '長期記憶', detail: '跨任務保留的記憶條目。' },
    },
    reclaimable: '可回收空間',
    reclaimableDetail: '任務資料庫中已釋放但尚未歸還磁碟的空間，已計入「任務資料庫」。',
    worktrees: '子代理工作樹',
    worktreesDetail: '只統計數量；每個工作樹的大小取決於對應專案的檢出內容。',
    worktreeCount: (count: number) => `${count} 個`,
    approximately: (size: string) => `≈ ${size}`,
    taskSize: (size: string) => `占用 ${size}`,
    taskSizeNote:
      '任務占用為估算值。卸載的上下文依任務引用計算，多個任務共享的內容會重複計入；刪除任務後用量歷史仍會保留。',
  },
  en: {
    title: 'Storage',
    help: 'Space used by this Runtime Host’s data. Read-only: nothing here deletes or compacts data.',
    loading: 'Measuring…',
    loadFailed: 'Could not measure storage',
    refresh: 'Measure again',
    total: 'Total',
    totalDetail:
      'The sum of the rows below. Values marked ≈ are estimated from records and may overlap slightly with another row.',
    kinds: {
      database: {
        label: 'Task database',
        detail:
          'Task conversations, run logs, usage history, and indexes. Usage history is kept after a task is deleted so usage totals stay complete.',
      },
      artifacts: {
        label: 'Artifacts',
        detail: 'Files that tasks produced or imported, by their recorded size.',
      },
      context_offload: {
        label: 'Offloaded context',
        detail: 'Long content moved out of the model context. Identical content is stored once.',
      },
      memory: { label: 'Long-term memory', detail: 'Memories kept across tasks.' },
    },
    reclaimable: 'Reclaimable space',
    reclaimableDetail:
      'Space the task database has freed but not returned to the disk. Included in Task database.',
    worktrees: 'Subagent worktrees',
    worktreesDetail: 'Counted only. Each worktree’s size depends on its project checkout.',
    worktreeCount: (count: number) => (count === 1 ? '1 worktree' : `${count} worktrees`),
    approximately: (size: string) => `≈ ${size}`,
    taskSize: (size: string) => `Uses ${size}`,
    taskSizeNote:
      'Task sizes are estimates. Offloaded context is counted for every task that references it, so shared content is counted more than once. Usage history is kept after a task is deleted.',
  },
} satisfies UiCatalog<StorageUsageCopy>;

export function getStorageUsageCopy(locale: UiLocale): StorageUsageCopy {
  return STORAGE_USAGE_COPY[locale];
}
