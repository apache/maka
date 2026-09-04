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

import type { LocalMemoryState } from '@maka/core/local-memory';

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

type MemoryTextKey =
  | 'localFile' | 'localFileHelp' | 'enableLocalFile' | 'agentReadable' | 'agentReadableHelp' | 'enableAgentRead'
  | 'waitingFile' | 'waitingBackup' | 'dirty' | 'savedDraft'
  | 'backupCandidates' | 'backupCandidatesAria' | 'opening' | 'open' | 'restoring' | 'restore' | 'copying' | 'copyReference'
  | 'backupHelp' | 'savedAt' | 'previewPaused' | 'filterAria' | 'filterPlaceholder' | 'clear' | 'filterEmpty'
  | 'filterEmptyHelp' | 'activeMemories' | 'archivedMemories' | 'waitingEntry' | 'waitingEntryHelp' | 'manualAddAria'
  | 'manualAdd' | 'manualAddHelp' | 'title' | 'titlePlaceholder' | 'tags' | 'tagsPlaceholder' | 'content'
  | 'contentPlaceholder' | 'addDraft' | 'sensitiveDraft' | 'sensitiveDraftHelp' | 'fileContent'
  | 'fileActionsAria' | 'saving' | 'save' | 'saved' | 'openFile' | 'openFolder' | 'loading' | 'reload'
  | 'openPrevious' | 'copyPath' | 'copyPrevious' | 'resetting' | 'resetBackup' | 'restorePrevious'
  | 'archiveDraftNotice' | 'noMatchEntry' | 'noEntry' | 'created' | 'updated' | 'archivedNoPrompt' | 'activePrompt'
  | 'locateDraft' | 'promptPreview' | 'willInject' | 'willNotInject'
  | 'copyContext' | 'promptPreviewHelp' | 'safeModePreview' | 'emptyPromptPreview'
  | 'loadFailed' | 'reloaded' | 'reloadDiscarded' | 'toggleFailed' | 'agentReadFailed' | 'saveBlocked' | 'safeMode'
  | 'savedRedacted' | 'savedFile' | 'saveFailed' | 'resetDone' | 'resetDoneDetail' | 'resetFailed' | 'noBackup'
  | 'noBackupDetail' | 'restoreLatestTitle' | 'restoreCandidateTitle' | 'confirmRestore' | 'cancel' | 'restoredLatest'
  | 'restoredCandidate' | 'restoredDetail' | 'restoreFailed' | 'restoreLatestFailed' | 'restoreCandidateFailed'
  | 'openFailed' | 'openPreviousFailed' | 'pathCopied' | 'copyFailed' | 'copyFailedDetail' | 'backupReferenceCopied'
  | 'entryReferenceCopied' | 'locateFailed' | 'locateFailedDetail' | 'emptyTitle' | 'emptyTitleDetail' | 'emptyContent'
  | 'emptyContentDetail' | 'draftOversize' | 'oversizeDetail' | 'addedDraft' | 'addedDraftDetail' | 'updateFailed'
  | 'invalidIdDetail' | 'archivedDraft' | 'restoredDraft' | 'updateBlocked' | 'archived' | 'restored' | 'archiveFailed'
  | 'entryRestoreFailed' | 'promptCopied' | 'promptCopiedDetail'
  | 'restoreDraftAction' | 'archiveDraftAction' | 'restoreAction' | 'archiveAction';

export type MemorySettingsCopy = {
  intlLocale: string;
  text: Record<MemoryTextKey, string>;
  origins: Record<NonNullable<LocalMemoryState['latestEntry']>['origin'], string>;
  entryStatuses: Record<LocalMemoryState['entries'][number]['status'], string>;
  backupKinds: Record<NonNullable<LocalMemoryState['latestBackup']>['kind'], string>;
  memoryStatuses: Record<LocalMemoryState['status'], string>;
  promptBlocked: { disabled: string; incognito: string; safeMode: string; agentRead: string };
  countActive(count: number, draft?: boolean): string;
  countArchived(count: number, draft?: boolean): string;
  saveSummary(active: number, archived: number): string;
  backupSummary(active: number, archived: number): string;
  backupOversize: string;
  countEntries(count: number): string;
  countMatches(filtered: number, total: number): string;
  listAria(title: string): string;
  entryActionsAria(title: string): string;
  entryActionAria(action: string, identity: string): string;
  openBackupAria(label: string): string;
  restoreBackupAria(label: string): string;
  copyBackupAria(label: string): string;
  draftStatusAria(action: string): string;
  restoreLatestDescription(label: string): string;
  restoreCandidateDescription(label: string): string;
  redactedDetail(summary: string): string;
  openBackupFailed(kind: string): string;
  previewOversize: string;
  previewTruncationMarker: string;
  previewTruncated(limit: string): string;
  previewUsage(length: string, limit: string): string;
  previewLimit(limit: string): string;
};

const zhText = {
  localFile: '本地 MEMORY.md', localFileHelp: '透明 Markdown 文件，保存在当前本机工作区。这里的内容不会自动从聊天里抽取。', enableLocalFile: '启用本地 MEMORY.md', agentReadable: '模型上下文可读取', agentReadableHelp: '默认关闭。开启后，发送消息时会把本地记忆一并提供给模型；隐身模式下仍然不提供。', enableAgentRead: '允许模型上下文读取本地记忆', waitingFile: '等待创建 MEMORY.md', waitingBackup: '等待生成上一版备份', dirty: '有未保存修改', savedDraft: '草稿已保存', backupCandidates: '备份候选', backupCandidatesAria: '本地记忆备份候选列表', opening: '打开中…', open: '打开', restoring: '恢复中…', restore: '恢复', copying: '复制中…', copyReference: '复制引用', backupHelp: '上一版操作会使用最近的候选；这里只显示 metadata，不展示备份正文。', savedAt: '保存于 ', previewPaused: '草稿条目预览暂停', filterAria: '筛选本地记忆', filterPlaceholder: '筛选标题、内容、ID 或标签', clear: '清除', filterEmpty: '没有匹配的记忆条目', filterEmptyHelp: '筛选不会修改 MEMORY.md；清除筛选后会恢复显示全部条目。', activeMemories: '生效记忆', archivedMemories: '已归档记忆', waitingEntry: '等待添加记忆条目', waitingEntryHelp: '在任务里确认记忆，或点右上角「添加记忆」。', manualAddAria: '手动添加本地记忆', manualAdd: '手动添加记忆', manualAddHelp: '填写后立即写入本机 MEMORY.md。', title: '记忆标题', titlePlaceholder: '标题', tags: '记忆标签', tagsPlaceholder: '标签（逗号分隔，可选）', content: '记忆内容', contentPlaceholder: '内容', addDraft: '添加记忆', sensitiveDraft: '草稿含疑似敏感字段', sensitiveDraftHelp: '保存时会先遮蔽疑似 token、API key 或密码，再写入 MEMORY.md。', fileContent: 'MEMORY.md 内容', fileActionsAria: 'MEMORY.md 文件操作', saving: '保存中…', save: '保存', saved: '已保存', openFile: '打开 MEMORY.md', openFolder: '打开所在目录', loading: '载入中…', reload: '重新载入', openPrevious: '打开上一版', copyPath: '复制路径', copyPrevious: '复制上一版引用', resetting: '重置中…', resetBackup: '重置并备份', restorePrevious: '恢复上一版', archiveDraftNotice: '当前归档/恢复操作只更新草稿，保存后才会写入 MEMORY.md。', noMatchEntry: '无匹配条目。', noEntry: '暂无条目。', created: '创建 ', updated: '更新 ', archivedNoPrompt: '已归档，不会提供给模型', activePrompt: '生效条目，发送时会提供给模型', locateDraft: '定位草稿', promptPreview: '模型上下文预览', willInject: '发送时会提供', willNotInject: '当前不会提供', copyContext: '复制上下文', promptPreviewHelp: '这里是发送时会提供给模型的内容；已归档条目不在其中，疑似密钥会遮蔽。', safeModePreview: 'MEMORY.md 过大，当前不会生成模型上下文预览。', emptyPromptPreview: '没有生效记忆会提供给模型。', loadFailed: '载入本地记忆失败', reloaded: '已重新载入 MEMORY.md', reloadDiscarded: '未保存的草稿修改已丢弃。', toggleFailed: '更新本地记忆开关失败', agentReadFailed: '更新模型读取权限失败', saveBlocked: '保存被拦截', safeMode: 'MEMORY.md 内容过大，已进入安全模式。', savedRedacted: '已保存并遮蔽敏感字段', savedFile: '已保存 MEMORY.md', saveFailed: '保存 MEMORY.md 失败', resetDone: '已重置 MEMORY.md', resetDoneDetail: '上一版已保存为备份文件。', resetFailed: '重置 MEMORY.md 失败', noBackup: '没有可恢复备份', noBackupDetail: '保存或重置 MEMORY.md 后才会生成上一版备份。', restoreLatestTitle: '恢复上一版 MEMORY.md？', restoreCandidateTitle: '恢复这个 MEMORY.md 备份？', confirmRestore: '恢复', cancel: '取消', restoredLatest: '已恢复上一版 MEMORY.md', restoredCandidate: '已恢复 MEMORY.md 备份候选', restoredDetail: '恢复前的当前文件已保存为 restore.bak。', restoreFailed: '恢复失败', restoreLatestFailed: '恢复上一版失败', restoreCandidateFailed: '恢复备份失败', openFailed: '打开失败', openPreviousFailed: '打开上一版失败', pathCopied: '已复制路径', copyFailed: '复制失败', copyFailedDetail: '剪贴板不可用或被系统拒绝。', backupReferenceCopied: '已复制上一版引用', entryReferenceCopied: '已复制记忆引用', locateFailed: '无法定位记忆', locateFailedDetail: '当前草稿里找不到这条记忆；请先保存或刷新后重试。', emptyTitle: '标题不能为空', emptyTitleDetail: '给这条记忆起一个短标题。', emptyContent: '内容不能为空', emptyContentDetail: '写下要保留的偏好或事实。', draftOversize: '草稿过大', oversizeDetail: 'MEMORY.md 超出安全上限，请先删减旧内容。', addedDraft: '已添加记忆', addedDraftDetail: '已写入 MEMORY.md。', updateFailed: '无法更新记忆', invalidIdDetail: '这条记忆没有可识别 ID，已停止更新。', archivedDraft: '已在草稿中归档记忆', restoredDraft: '已在草稿中恢复记忆', updateBlocked: '更新被拦截', archived: '已归档记忆', restored: '已恢复记忆', archiveFailed: '归档记忆失败', entryRestoreFailed: '恢复记忆失败', promptCopied: '已复制模型上下文预览', promptCopiedDetail: '使用同一条 prompt 预览和遮蔽路径。', restoreDraftAction: '恢复到草稿', archiveDraftAction: '归档到草稿', restoreAction: '恢复', archiveAction: '归档',
} satisfies Record<MemoryTextKey, string>;

const zhTwText = {
  localFile: '本地 MEMORY.md', localFileHelp: '透明 Markdown 檔案，儲存在目前本機工作區。這裡的內容不會自動從聊天裡抽取。', enableLocalFile: '啟用本地 MEMORY.md', agentReadable: '模型上下文可讀取', agentReadableHelp: '預設關閉。開啟後，傳送訊息時會把本地記憶一併提供給模型；隱身模式下仍然不提供。', enableAgentRead: '允許模型上下文讀取本地記憶', waitingFile: '等待建立 MEMORY.md', waitingBackup: '等待生成上一版備份', dirty: '有未儲存修改', savedDraft: '草稿已儲存', backupCandidates: '備份候選', backupCandidatesAria: '本地記憶備份候選列表', opening: '開啟中…', open: '開啟', restoring: '恢復中…', restore: '恢復', copying: '複製中…', copyReference: '複製引用', backupHelp: '上一版操作會使用最近的候選；這裡只顯示 metadata，不展示備份正文。', savedAt: '儲存於 ', previewPaused: '草稿條目預覽暫停', filterAria: '篩選本地記憶', filterPlaceholder: '篩選標題、內容、ID 或標籤', clear: '清除', filterEmpty: '沒有符合的記憶條目', filterEmptyHelp: '篩選不會修改 MEMORY.md；清除篩選後會恢復顯示全部條目。', activeMemories: '生效記憶', archivedMemories: '已歸檔記憶', waitingEntry: '等待新增記憶條目', waitingEntryHelp: '在任務裡確認記憶，或點右上角「新增記憶」。', manualAddAria: '手動新增本地記憶', manualAdd: '手動新增記憶', manualAddHelp: '填寫後立即寫入本機 MEMORY.md。', title: '記憶標題', titlePlaceholder: '標題', tags: '記憶標籤', tagsPlaceholder: '標籤（逗號分隔，可選）', content: '記憶內容', contentPlaceholder: '內容', addDraft: '新增記憶', sensitiveDraft: '草稿含疑似敏感欄位', sensitiveDraftHelp: '儲存時會先遮蔽疑似 token、API key 或密碼，再寫入 MEMORY.md。', fileContent: 'MEMORY.md 內容', fileActionsAria: 'MEMORY.md 檔案操作', saving: '儲存中…', save: '儲存', saved: '已儲存', openFile: '開啟 MEMORY.md', openFolder: '開啟所在目錄', loading: '載入中…', reload: '重新載入', openPrevious: '開啟上一版', copyPath: '複製路徑', copyPrevious: '複製上一版引用', resetting: '重置中…', resetBackup: '重置並備份', restorePrevious: '恢復上一版', archiveDraftNotice: '目前歸檔/恢復操作只更新草稿，儲存後才會寫入 MEMORY.md。', noMatchEntry: '無符合條目。', noEntry: '暫無條目。', created: '建立 ', updated: '更新 ', archivedNoPrompt: '已歸檔，不會提供給模型', activePrompt: '生效條目，傳送時會提供給模型', locateDraft: '定位草稿', promptPreview: '模型上下文預覽', willInject: '傳送時會提供', willNotInject: '目前不會提供', copyContext: '複製上下文', promptPreviewHelp: '這裡是傳送時會提供給模型的內容；已歸檔條目不在其中，疑似金鑰會遮蔽。', safeModePreview: 'MEMORY.md 過大，目前不會生成模型上下文預覽。', emptyPromptPreview: '沒有生效記憶會提供給模型。', loadFailed: '載入本地記憶失敗', reloaded: '已重新載入 MEMORY.md', reloadDiscarded: '未儲存的草稿修改已丟棄。', toggleFailed: '更新本地記憶開關失敗', agentReadFailed: '更新模型讀取權限失敗', saveBlocked: '儲存被攔截', safeMode: 'MEMORY.md 內容過大，已進入安全模式。', savedRedacted: '已儲存並遮蔽敏感欄位', savedFile: '已儲存 MEMORY.md', saveFailed: '儲存 MEMORY.md 失敗', resetDone: '已重置 MEMORY.md', resetDoneDetail: '上一版已儲存為備份檔案。', resetFailed: '重置 MEMORY.md 失敗', noBackup: '沒有可恢復備份', noBackupDetail: '儲存或重置 MEMORY.md 後才會生成上一版備份。', restoreLatestTitle: '恢復上一版 MEMORY.md？', restoreCandidateTitle: '恢復這個 MEMORY.md 備份？', confirmRestore: '恢復', cancel: '取消', restoredLatest: '已恢復上一版 MEMORY.md', restoredCandidate: '已恢復 MEMORY.md 備份候選', restoredDetail: '恢復前的目前檔案已儲存為 restore.bak。', restoreFailed: '恢復失敗', restoreLatestFailed: '恢復上一版失敗', restoreCandidateFailed: '恢復備份失敗', openFailed: '開啟失敗', openPreviousFailed: '開啟上一版失敗', pathCopied: '已複製路徑', copyFailed: '複製失敗', copyFailedDetail: '剪貼簿不可用或被系統拒絕。', backupReferenceCopied: '已複製上一版引用', entryReferenceCopied: '已複製記憶引用', locateFailed: '無法定位記憶', locateFailedDetail: '目前草稿裡找不到這條記憶；請先儲存或重新整理後重試。', emptyTitle: '標題不能為空', emptyTitleDetail: '給這條記憶起一個短標題。', emptyContent: '內容不能為空', emptyContentDetail: '寫下要保留的偏好或事實。', draftOversize: '草稿過大', oversizeDetail: 'MEMORY.md 超出安全上限，請先刪減舊內容。', addedDraft: '已新增記憶', addedDraftDetail: '已寫入 MEMORY.md。', updateFailed: '無法更新記憶', invalidIdDetail: '這條記憶沒有可識別 ID，已停止更新。', archivedDraft: '已在草稿中歸檔記憶', restoredDraft: '已在草稿中恢復記憶', updateBlocked: '更新被攔截', archived: '已歸檔記憶', restored: '已恢復記憶', archiveFailed: '歸檔記憶失敗', entryRestoreFailed: '恢復記憶失敗', promptCopied: '已複製模型上下文預覽', promptCopiedDetail: '使用同一條 prompt 預覽和遮蔽路徑。', restoreDraftAction: '恢復到草稿', archiveDraftAction: '歸檔到草稿', restoreAction: '恢復', archiveAction: '歸檔',
} satisfies Record<MemoryTextKey, string>;

const enText = {
  localFile: 'Local MEMORY.md', localFileHelp: 'A transparent Markdown file stored in the current local workspace. Content is never extracted from chats automatically.', enableLocalFile: 'Enable local MEMORY.md', agentReadable: 'Available to model context', agentReadableHelp: 'Off by default. When enabled, local memory is given to the model along with your message; incognito mode still withholds it.', enableAgentRead: 'Allow model context to read local memory', waitingFile: 'Waiting to create MEMORY.md', waitingBackup: 'Waiting to create a previous-version backup', dirty: 'Unsaved changes', savedDraft: 'Draft saved', backupCandidates: 'Backup candidates', backupCandidatesAria: 'Local memory backup candidates', opening: 'Opening…', open: 'Open', restoring: 'Restoring…', restore: 'Restore', copying: 'Copying…', copyReference: 'Copy reference', backupHelp: 'Previous-version actions use the latest candidate. Only metadata is shown here, never backup contents.', savedAt: 'Saved ', previewPaused: 'Draft entry preview paused', filterAria: 'Filter local memory', filterPlaceholder: 'Filter title, content, ID, or tags', clear: 'Clear', filterEmpty: 'No matching memory entries', filterEmptyHelp: 'Filtering does not modify MEMORY.md. Clear the filter to show all entries.', activeMemories: 'Active memories', archivedMemories: 'Archived memories', waitingEntry: 'Ready to add a memory entry', waitingEntryHelp: 'Confirm a memory in chat, or use "Add memory" above.', manualAddAria: 'Add local memory manually', manualAdd: 'Add memory manually', manualAddHelp: 'Written to the local MEMORY.md immediately.', title: 'Memory title', titlePlaceholder: 'Title', tags: 'Memory tags', tagsPlaceholder: 'Tags (comma-separated, optional)', content: 'Memory content', contentPlaceholder: 'Content', addDraft: 'Add memory', sensitiveDraft: 'Draft may contain sensitive fields', sensitiveDraftHelp: 'Suspected tokens, API keys, and passwords are redacted before MEMORY.md is written.', fileContent: 'MEMORY.md content', fileActionsAria: 'MEMORY.md file actions', saving: 'Saving…', save: 'Save', saved: 'Saved', openFile: 'Open MEMORY.md', openFolder: 'Open containing folder', loading: 'Loading…', reload: 'Reload', openPrevious: 'Open previous version', copyPath: 'Copy path', copyPrevious: 'Copy previous-version reference', resetting: 'Resetting…', resetBackup: 'Reset and back up', restorePrevious: 'Restore previous version', archiveDraftNotice: 'Archive and restore actions update only the draft until you save MEMORY.md.', noMatchEntry: 'No matching entries.', noEntry: 'No entries yet.', created: 'Created ', updated: 'Updated ', archivedNoPrompt: 'Archived; not given to the model', activePrompt: 'Active entry; given to the model when you send', locateDraft: 'Locate in draft', promptPreview: 'Model context preview', willInject: 'Included when sending', willNotInject: 'Not currently included', copyContext: 'Copy context', promptPreviewHelp: 'What will be given to the model when you send. Archived entries are excluded and suspected secrets are redacted.', safeModePreview: 'MEMORY.md is too large, so no model-context preview is generated.', emptyPromptPreview: 'No active memories will be given to the model.', loadFailed: 'Failed to load local memory', reloaded: 'MEMORY.md reloaded', reloadDiscarded: 'Unsaved draft changes were discarded.', toggleFailed: 'Failed to update local memory', agentReadFailed: 'Failed to update model read access', saveBlocked: 'Save blocked', safeMode: 'MEMORY.md is too large and entered safe mode.', savedRedacted: 'Saved with sensitive fields redacted', savedFile: 'MEMORY.md saved', saveFailed: 'Failed to save MEMORY.md', resetDone: 'MEMORY.md reset', resetDoneDetail: 'The previous version was saved as a backup.', resetFailed: 'Failed to reset MEMORY.md', noBackup: 'No backup available to restore', noBackupDetail: 'A previous-version backup is created after you save or reset MEMORY.md.', restoreLatestTitle: 'Restore the previous MEMORY.md version?', restoreCandidateTitle: 'Restore this MEMORY.md backup?', confirmRestore: 'Restore', cancel: 'Cancel', restoredLatest: 'Previous MEMORY.md version restored', restoredCandidate: 'MEMORY.md backup candidate restored', restoredDetail: 'The file from before the restore was saved as restore.bak.', restoreFailed: 'Restore failed', restoreLatestFailed: 'Failed to restore previous version', restoreCandidateFailed: 'Failed to restore backup', openFailed: 'Open failed', openPreviousFailed: 'Failed to open previous version', pathCopied: 'Path copied', copyFailed: 'Copy failed', copyFailedDetail: 'The clipboard is unavailable or access was denied by the system.', backupReferenceCopied: 'Previous-version reference copied', entryReferenceCopied: 'Memory reference copied', locateFailed: 'Could not locate memory', locateFailedDetail: 'This memory is not in the current draft. Save or reload, then try again.', emptyTitle: 'Title is required', emptyTitleDetail: 'Give this memory a short title.', emptyContent: 'Content is required', emptyContentDetail: 'Enter the preference or fact to retain.', draftOversize: 'Draft is too large', oversizeDetail: 'MEMORY.md exceeds the safety limit. Remove older content first.', addedDraft: 'Memory added', addedDraftDetail: 'Written to MEMORY.md.', updateFailed: 'Could not update memory', invalidIdDetail: 'This memory has no recognizable ID, so the update was stopped.', archivedDraft: 'Memory archived in draft', restoredDraft: 'Memory restored in draft', updateBlocked: 'Update blocked', archived: 'Memory archived', restored: 'Memory restored', archiveFailed: 'Failed to archive memory', entryRestoreFailed: 'Failed to restore memory', promptCopied: 'Model context preview copied', promptCopiedDetail: 'Uses the same prompt-preview and redaction path.', restoreDraftAction: 'Restore to draft', archiveDraftAction: 'Archive in draft', restoreAction: 'Restore', archiveAction: 'Archive',
} satisfies Record<MemoryTextKey, string>;

const SETTINGS_MEMORY_COPY = {
  'zh-CN': makeCopy('zh-CN', zhText, {
    origins: { manual: '手动记录', imported: '导入记录', extracted: '确认提取', unknown: '手写条目' }, entryStatuses: { draft: '草稿', review_required: '待确认', active: '生效', archived: '已归档', rejected: '已拒绝', unknown: '未识别' }, backupKinds: { reset: '重置前备份', restore: '恢复前备份', save: '保存前备份' }, memoryStatuses: { ok: '本地文件已就绪', disabled: '已关闭', safe_mode: '安全模式', incognito_blocked: '隐身禁用', error: '读取失败' }, promptBlocked: { disabled: '本地记忆已关闭。', incognito: '隐身模式下不会提供本地记忆。', safeMode: 'MEMORY.md 过大，当前不会提供。', agentRead: '模型上下文读取未开启。' }, backupOversize: '备份过大，无法预览条目', previewOversize: '草稿过大，条目预览已暂停；保存前请先删减 MEMORY.md 内容。', previewTruncationMarker: '[本地记忆已按长度截断]',
  }),
  'zh-TW': makeCopy('zh-TW', zhTwText, {
    origins: { manual: '手動記錄', imported: '匯入記錄', extracted: '確認提取', unknown: '手寫條目' }, entryStatuses: { draft: '草稿', review_required: '待確認', active: '生效', archived: '已歸檔', rejected: '已拒絕', unknown: '未識別' }, backupKinds: { reset: '重置前備份', restore: '恢復前備份', save: '儲存前備份' }, memoryStatuses: { ok: '本地檔案已就緒', disabled: '已關閉', safe_mode: '安全模式', incognito_blocked: '隱身停用', error: '讀取失敗' }, promptBlocked: { disabled: '本地記憶已關閉。', incognito: '隱身模式下不會提供本地記憶。', safeMode: 'MEMORY.md 過大，目前不會提供。', agentRead: '模型上下文讀取未開啟。' }, backupOversize: '備份過大，無法預覽條目', previewOversize: '草稿過大，條目預覽已暫停；儲存前請先刪減 MEMORY.md 內容。', previewTruncationMarker: '[本地記憶已按長度截斷]',
  }),
  en: makeCopy('en-US', enText, {
    origins: { manual: 'Manual entry', imported: 'Imported entry', extracted: 'Confirmed extraction', unknown: 'Handwritten entry' }, entryStatuses: { draft: 'Draft', review_required: 'Needs review', active: 'Active', archived: 'Archived', rejected: 'Rejected', unknown: 'Unrecognized' }, backupKinds: { reset: 'Before reset', restore: 'Before restore', save: 'Before save' }, memoryStatuses: { ok: 'Local file ready', disabled: 'Off', safe_mode: 'Safe mode', incognito_blocked: 'Disabled in incognito', error: 'Read failed' }, promptBlocked: { disabled: 'Local memory is disabled.', incognito: 'Local memory is never added in incognito mode.', safeMode: 'MEMORY.md is too large and will not be added.', agentRead: 'Model context access is disabled.' }, backupOversize: 'Backup is too large to preview entries', previewOversize: 'The draft is too large, so entry preview is paused. Reduce MEMORY.md before saving.', previewTruncationMarker: '[Local memory truncated to the length limit]',
  }),
} satisfies UiCatalog<MemorySettingsCopy>;

export function getMemorySettingsCopy(locale: UiLocale): MemorySettingsCopy { return SETTINGS_MEMORY_COPY[locale]; }

function makeCopy(intlLocale: string, text: Record<MemoryTextKey, string>, values: Pick<MemorySettingsCopy, 'origins' | 'entryStatuses' | 'backupKinds' | 'memoryStatuses' | 'promptBlocked' | 'backupOversize' | 'previewOversize' | 'previewTruncationMarker'>): MemorySettingsCopy {
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const isZh = intlLocale !== 'en-US';
  const isZhTw = intlLocale === 'zh-TW';
  const zh = (simplified: string, traditional: string) => isZhTw ? traditional : simplified;
  return {
    intlLocale, text, ...values,
    countActive: (count, draft) => isZh ? `${draft ? '草稿 ' : ''}${count} ${zh('条生效', '則生效')}` : `${draft ? 'Draft · ' : ''}${plural(count, 'active entry', 'active entries')}`,
    countArchived: (count, draft) => isZh ? `${draft ? '草稿 ' : ''}${count} ${zh('条已归档', '則已歸檔')}` : `${draft ? 'Draft · ' : ''}${plural(count, 'archived entry', 'archived entries')}`,
    saveSummary: (active, archived) => isZh ? `${zh('当前', '目前')} ${active} ${zh('条生效', '則生效')}${archived > 0 ? ` / ${archived} ${zh('条已归档', '則已歸檔')}` : ''}；${zh('已保留上一版备份。', '已保留上一版備份。')}` : `${plural(active, 'active entry', 'active entries')}${archived > 0 ? ` / ${plural(archived, 'archived entry', 'archived entries')}` : ''}; the previous version was backed up.`,
    backupSummary: (active, archived) => isZh ? `${active} ${zh('条生效', '則生效')}${archived > 0 ? ` / ${archived} ${zh('条已归档', '則已歸檔')}` : ''}` : `${plural(active, 'active entry', 'active entries')}${archived > 0 ? ` / ${plural(archived, 'archived entry', 'archived entries')}` : ''}`,
    countEntries: (count) => isZh ? `${count} ${zh('条记忆', '則記憶')}` : plural(count, 'memory', 'memories'),
    countMatches: (filtered, total) => isZh ? `${filtered} / ${total} ${zh('条匹配', '則符合')}` : `${filtered} / ${total} matching`,
    listAria: (title) => isZh ? `${title}${zh('列表', '清單')}` : `${title} list`,
    entryActionsAria: (title) => isZh ? `${title} ${zh('记忆操作', '記憶操作')}` : `${title} memory actions`,
    entryActionAria: (action, identity) => isZh ? `${action}：${identity}` : `${action}: ${identity}`,
    openBackupAria: (label) => isZh ? `${zh('打开备份候选', '開啟備份候選')} ${label}` : `Open backup candidate ${label}`, restoreBackupAria: (label) => isZh ? `${zh('恢复备份候选', '還原備份候選')} ${label}` : `Restore backup candidate ${label}`, copyBackupAria: (label) => isZh ? `${zh('复制备份候选引用', '複製備份候選引用')} ${label}` : `Copy backup candidate reference ${label}`,
    draftStatusAria: (action) => isZh ? `${action}，${zh('保存前不会写入', '儲存前不會寫入')} MEMORY.md` : `${action}; MEMORY.md is not written until you save`,
    restoreLatestDescription: (label) => isZh ? `${zh('会先备份当前 MEMORY.md，再用最近一次备份覆盖当前文件。将恢复', '會先備份目前的 MEMORY.md，再以最近一次備份覆蓋目前檔案。將還原')}：${label}` : `The current MEMORY.md will be backed up before the latest backup replaces it. Restore: ${label}`,
    restoreCandidateDescription: (label) => isZh ? `${zh('会先备份当前 MEMORY.md，再用选中的备份覆盖当前文件。将恢复', '會先備份目前的 MEMORY.md，再以選取的備份覆蓋目前檔案。將還原')}：${label}` : `The current MEMORY.md will be backed up before the selected backup replaces it. Restore: ${label}`,
    redactedDetail: (summary) => isZh ? `${zh('写入前已替换疑似', '寫入前已遮蔽疑似')} token、API key ${zh('或密码', '或密碼')}；${summary}` : `Suspected tokens, API keys, or passwords were redacted before writing; ${summary}`,
    openBackupFailed: (kind) => isZh ? `${zh('打开', '開啟')}${kind}${zh('失败', '失敗')}` : `Failed to open ${kind}`,
    previewTruncated: (limit) => isZh ? `${zh('预览已按', '預覽已依')} ${limit} ${zh('字符上限截断', '字元上限截斷')}` : `Preview truncated at the ${limit}-character limit`,
    previewUsage: (length, limit) => isZh ? `${zh('预览', '預覽')} ${length} / ${limit} ${zh('字符', '字元')}` : `Preview ${length} / ${limit} characters`,
    previewLimit: (limit) => isZh ? `prompt ${zh('上限', '上限')} ${limit} ${zh('字符', '字元')}` : `Prompt limit: ${limit} characters`,
  };
}
