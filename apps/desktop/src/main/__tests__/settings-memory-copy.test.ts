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

import assert from 'node:assert/strict';
import test from 'node:test';
import { UI_LOCALES, type UiCatalog } from '@maka/core/ui-locale';
import {
  getMemorySettingsCopy,
  memoryResultMessage,
  type MemoryResultCode,
} from '../../renderer/locales/settings-memory-copy.js';

const rejectionCopy = {
  invalid_content: ['MEMORY.md content is invalid. Check its format and try again.', 'MEMORY.md 内容无效，请检查格式后重试。'],
  invalid_scope: ['The memory operation has an invalid scope.', '当前记忆操作的作用域无效。'],
  not_found: ['The memory entry was not found.', '找不到对应的记忆条目。'],
  not_pending: ['The memory entry is not pending review.', '对应的记忆条目不在待确认状态。'],
  upload_not_found: ['The memory upload session does not exist or has expired.', '记忆上传会话不存在或已过期。'],
  upload_incomplete: ['The memory content has not finished uploading.', '记忆内容尚未上传完整。'],
  upload_conflict: ['Another memory upload is in progress. Try again.', '另一个记忆上传正在进行，请重试。'],
} satisfies Partial<Record<MemoryResultCode, readonly [string, string]>>;

test('renders Runtime Host memory rejection codes per locale', () => {
  for (const [code, [en, zh]] of Object.entries(rejectionCopy)) {
    assert.equal(memoryResultMessage({ code }, getMemorySettingsCopy('en'), 'fallback'), en);
    assert.equal(memoryResultMessage({ code }, getMemorySettingsCopy('zh-CN'), 'fallback'), zh);
  }
});

test('falls back for an unknown Runtime Host memory rejection code', () => {
  assert.equal(
    memoryResultMessage({ code: 'future_host_code' }, getMemorySettingsCopy('en'), 'fallback'),
    'fallback',
  );
});

const formattedCopy = {
  'zh-CN': {
    counts: [
      ['0 条生效', '草稿 0 条生效', '0 条已归档', '草稿 0 条已归档', '0 条记忆'],
      ['1 条生效', '草稿 1 条生效', '1 条已归档', '草稿 1 条已归档', '1 条记忆'],
      ['2 条生效', '草稿 2 条生效', '2 条已归档', '草稿 2 条已归档', '2 条记忆'],
    ],
    summaries: [
      ['当前 0 条生效；已保留上一版备份。', '0 条生效'],
      ['当前 1 条生效；已保留上一版备份。', '1 条生效'],
      ['当前 2 条生效；已保留上一版备份。', '2 条生效'],
      ['当前 0 条生效 / 2 条已归档；已保留上一版备份。', '0 条生效 / 2 条已归档'],
      ['当前 1 条生效 / 1 条已归档；已保留上一版备份。', '1 条生效 / 1 条已归档'],
      ['当前 1 条生效 / 2 条已归档；已保留上一版备份。', '1 条生效 / 2 条已归档'],
      ['当前 2 条生效 / 1 条已归档；已保留上一版备份。', '2 条生效 / 1 条已归档'],
      ['当前 2 条生效 / 2 条已归档；已保留上一版备份。', '2 条生效 / 2 条已归档'],
    ],
    redacted: [
      '写入前已替换疑似 token、API key 或密码；当前 1 条生效；已保留上一版备份。',
      '写入前已替换疑似 token、API key 或密码；当前 1 条生效 / 2 条已归档；已保留上一版备份。',
    ],
    backupFailures: ['打开重置前备份失败', '打开恢复前备份失败', '打开保存前备份失败'],
    preview: ['预览已按 8,000 字符上限截断', '预览 1,234 / 8,000 字符', 'prompt 上限 8,000 字符'],
    labels: [
      '0 / 0 条匹配', '1 / 2 条匹配', 'Memory #2列表', 'Memory #2 记忆操作',
      '归档：Memory #2', '打开备份候选 Backup #2', '恢复备份候选 Backup #2',
      '复制备份候选引用 Backup #2', '归档到草稿，保存前不会写入 MEMORY.md',
      '恢复到草稿，保存前不会写入 MEMORY.md',
      '会先备份当前 MEMORY.md，再用最近一次备份覆盖当前文件。将恢复：Backup #2',
      '会先备份当前 MEMORY.md，再用选中的备份覆盖当前文件。将恢复：Backup #2',
    ],
  },
  'zh-TW': {
    counts: [
      ['0 則生效', '草稿 0 則生效', '0 則已歸檔', '草稿 0 則已歸檔', '0 則記憶'],
      ['1 則生效', '草稿 1 則生效', '1 則已歸檔', '草稿 1 則已歸檔', '1 則記憶'],
      ['2 則生效', '草稿 2 則生效', '2 則已歸檔', '草稿 2 則已歸檔', '2 則記憶'],
    ],
    summaries: [
      ['目前 0 則生效；已保留上一版備份。', '0 則生效'],
      ['目前 1 則生效；已保留上一版備份。', '1 則生效'],
      ['目前 2 則生效；已保留上一版備份。', '2 則生效'],
      ['目前 0 則生效 / 2 則已歸檔；已保留上一版備份。', '0 則生效 / 2 則已歸檔'],
      ['目前 1 則生效 / 1 則已歸檔；已保留上一版備份。', '1 則生效 / 1 則已歸檔'],
      ['目前 1 則生效 / 2 則已歸檔；已保留上一版備份。', '1 則生效 / 2 則已歸檔'],
      ['目前 2 則生效 / 1 則已歸檔；已保留上一版備份。', '2 則生效 / 1 則已歸檔'],
      ['目前 2 則生效 / 2 則已歸檔；已保留上一版備份。', '2 則生效 / 2 則已歸檔'],
    ],
    redacted: [
      '寫入前已遮蔽疑似 token、API key 或密碼；目前 1 則生效；已保留上一版備份。',
      '寫入前已遮蔽疑似 token、API key 或密碼；目前 1 則生效 / 2 則已歸檔；已保留上一版備份。',
    ],
    backupFailures: ['開啟重置前備份失敗', '開啟恢復前備份失敗', '開啟儲存前備份失敗'],
    preview: ['預覽已依 8,000 字元上限截斷', '預覽 1,234 / 8,000 字元', 'prompt 上限 8,000 字元'],
    labels: [
      '0 / 0 則符合', '1 / 2 則符合', 'Memory #2清單', 'Memory #2 記憶操作',
      '歸檔：Memory #2', '開啟備份候選 Backup #2', '還原備份候選 Backup #2',
      '複製備份候選引用 Backup #2', '歸檔到草稿，儲存前不會寫入 MEMORY.md',
      '恢復到草稿，儲存前不會寫入 MEMORY.md',
      '會先備份目前的 MEMORY.md，再以最近一次備份覆蓋目前檔案。將還原：Backup #2',
      '會先備份目前的 MEMORY.md，再以選取的備份覆蓋目前檔案。將還原：Backup #2',
    ],
  },
  en: {
    counts: [
      ['0 active entries', 'Draft · 0 active entries', '0 archived entries', 'Draft · 0 archived entries', '0 memories'],
      ['1 active entry', 'Draft · 1 active entry', '1 archived entry', 'Draft · 1 archived entry', '1 memory'],
      ['2 active entries', 'Draft · 2 active entries', '2 archived entries', 'Draft · 2 archived entries', '2 memories'],
    ],
    summaries: [
      ['0 active entries; the previous version was backed up.', '0 active entries'],
      ['1 active entry; the previous version was backed up.', '1 active entry'],
      ['2 active entries; the previous version was backed up.', '2 active entries'],
      ['0 active entries / 2 archived entries; the previous version was backed up.', '0 active entries / 2 archived entries'],
      ['1 active entry / 1 archived entry; the previous version was backed up.', '1 active entry / 1 archived entry'],
      ['1 active entry / 2 archived entries; the previous version was backed up.', '1 active entry / 2 archived entries'],
      ['2 active entries / 1 archived entry; the previous version was backed up.', '2 active entries / 1 archived entry'],
      ['2 active entries / 2 archived entries; the previous version was backed up.', '2 active entries / 2 archived entries'],
    ],
    redacted: [
      'Suspected tokens, API keys, or passwords were redacted before writing; 1 active entry; the previous version was backed up.',
      'Suspected tokens, API keys, or passwords were redacted before writing; 1 active entry / 2 archived entries; the previous version was backed up.',
    ],
    backupFailures: ['Failed to open Before reset', 'Failed to open Before restore', 'Failed to open Before save'],
    preview: ['Preview truncated at the 8,000-character limit', 'Preview 1,234 / 8,000 characters', 'Prompt limit: 8,000 characters'],
    labels: [
      '0 / 0 matching', '1 / 2 matching', 'Memory #2 list', 'Memory #2 memory actions',
      'Archive: Memory #2', 'Open backup candidate Backup #2', 'Restore backup candidate Backup #2',
      'Copy backup candidate reference Backup #2', 'Archive in draft; MEMORY.md is not written until you save',
      'Restore to draft; MEMORY.md is not written until you save',
      'The current MEMORY.md will be backed up before the latest backup replaces it. Restore: Backup #2',
      'The current MEMORY.md will be backed up before the selected backup replaces it. Restore: Backup #2',
    ],
  },
} satisfies UiCatalog<{
  counts: string[][];
  summaries: string[][];
  redacted: string[];
  backupFailures: string[];
  preview: string[];
  labels: string[];
}>;

for (const locale of UI_LOCALES) {
  const expected = formattedCopy[locale];
  const copy = getMemorySettingsCopy(locale);

  test(`renders complete memory counts and summaries in ${locale}`, () => {
    for (const count of [0, 1, 2]) {
      assert.deepEqual([
        copy.countActive(count), copy.countActive(count, true),
        copy.countArchived(count), copy.countArchived(count, true), copy.countEntries(count),
      ], expected.counts[count]);
      assert.equal(copy.countActive(count, false), expected.counts[count][0]);
      assert.equal(copy.countArchived(count, false), expected.counts[count][2]);
    }
    const summaryCounts = [[0, 0], [1, 0], [2, 0], [0, 2], [1, 1], [1, 2], [2, 1], [2, 2]] as const;
    assert.deepEqual(summaryCounts.map(([active, archived]) => [
      copy.saveSummary(active, archived), copy.backupSummary(active, archived),
    ]), expected.summaries);
  });

  test(`renders complete redaction, backup failure, and preview messages in ${locale}`, () => {
    assert.deepEqual([0, 2].map((archived) => copy.redactedDetail(copy.saveSummary(1, archived))), expected.redacted);
    assert.deepEqual((['reset', 'restore', 'save'] as const).map((kind) => (
      copy.openBackupFailed(copy.backupKinds[kind])
    )), expected.backupFailures);
    assert.deepEqual([
      copy.previewTruncated('8,000'), copy.previewUsage('1,234', '8,000'), copy.previewLimit('8,000'),
    ], expected.preview);
  });

  test(`renders complete memory action and restore descriptions in ${locale}`, () => {
    assert.deepEqual([
      copy.countMatches(0, 0), copy.countMatches(1, 2), copy.listAria('Memory #2'),
      copy.entryActionsAria('Memory #2'), copy.entryActionAria(copy.text.archiveAction, 'Memory #2'),
      copy.openBackupAria('Backup #2'), copy.restoreBackupAria('Backup #2'), copy.copyBackupAria('Backup #2'),
      copy.draftStatusAria(copy.text.archiveDraftAction), copy.draftStatusAria(copy.text.restoreDraftAction),
      copy.restoreLatestDescription('Backup #2'), copy.restoreCandidateDescription('Backup #2'),
    ], expected.labels);
  });
}
