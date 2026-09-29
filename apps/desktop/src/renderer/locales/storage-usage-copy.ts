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

type StorageUsageKindCopy = { label: string; detail: string };

export type StorageUsageCopy = {
  title: string;
  help: string;
  loading: string;
  loadFailed: string;
  refresh: string;
  total: string;
  totalDetail: string;
  kinds: Record<
    | 'transcript'
    | 'runtime'
    | 'artifacts'
    | 'context_offload'
    | 'memory'
    | 'usage_history'
    | 'database',
    StorageUsageKindCopy
  >;
  reclaimable: string;
  reclaimableDetail: string;
  worktrees: string;
  worktreesDetail: string;
  worktreeCount(count: number): string;
  /** Prefix for a logical estimate rather than bytes on disk. */
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
    totalDetail: '下列各项之和。标注 ≈ 的是按记录内容估算的大小，不含索引等开销。',
    kinds: {
      transcript: { label: '任务对话', detail: '任务的消息记录。' },
      runtime: { label: '运行日志', detail: '任务运行过程中记录的事件。' },
      artifacts: { label: '产物文件', detail: '任务生成或导入的文件。' },
      context_offload: {
        label: '卸载的上下文',
        detail: '为节省上下文而移出的长内容，相同内容只保存一份。',
      },
      memory: { label: '长期记忆', detail: '跨任务保留的记忆条目。' },
      usage_history: {
        label: '用量历史',
        detail: '模型调用与工具使用记录。删除任务后仍会保留，以保证用量统计完整。',
      },
      database: { label: '其他数据与索引', detail: '其余任务记录、索引以及数据库中的空闲空间。' },
    },
    reclaimable: '可回收空间',
    reclaimableDetail: '数据库中已释放但尚未归还磁盘的空间，已计入「其他数据与索引」。',
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
    totalDetail: '下列各項之和。標註 ≈ 的是依記錄內容估算的大小，不含索引等開銷。',
    kinds: {
      transcript: { label: '任務對話', detail: '任務的訊息記錄。' },
      runtime: { label: '執行日誌', detail: '任務執行過程中記錄的事件。' },
      artifacts: { label: '產物檔案', detail: '任務生成或匯入的檔案。' },
      context_offload: {
        label: '卸載的上下文',
        detail: '為節省上下文而移出的長內容，相同內容只儲存一份。',
      },
      memory: { label: '長期記憶', detail: '跨任務保留的記憶條目。' },
      usage_history: {
        label: '用量歷史',
        detail: '模型呼叫與工具使用記錄。刪除任務後仍會保留，以確保用量統計完整。',
      },
      database: { label: '其他資料與索引', detail: '其餘任務記錄、索引以及資料庫中的閒置空間。' },
    },
    reclaimable: '可回收空間',
    reclaimableDetail: '資料庫中已釋放但尚未歸還磁碟的空間，已計入「其他資料與索引」。',
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
      'The sum of the rows below. Values marked ≈ are estimated from record contents and exclude index overhead.',
    kinds: {
      transcript: { label: 'Task conversations', detail: 'Message history of your tasks.' },
      runtime: { label: 'Run logs', detail: 'Events recorded while tasks run.' },
      artifacts: { label: 'Artifacts', detail: 'Files that tasks produced or imported.' },
      context_offload: {
        label: 'Offloaded context',
        detail: 'Long content moved out of the model context. Identical content is stored once.',
      },
      memory: { label: 'Long-term memory', detail: 'Memories kept across tasks.' },
      usage_history: {
        label: 'Usage history',
        detail: 'Model call and tool usage records. Kept after a task is deleted so usage totals stay complete.',
      },
      database: {
        label: 'Other data and indexes',
        detail: 'Remaining task records, indexes, and free space inside the database.',
      },
    },
    reclaimable: 'Reclaimable space',
    reclaimableDetail:
      'Space the database has freed but not returned to the disk. Included in Other data and indexes.',
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
