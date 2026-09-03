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
type MemoryTextKey = 'localFile' | 'localFileHelp' | 'enableLocalFile' | 'agentReadable' | 'agentReadableHelp' | 'enableAgentRead' | 'waitingFile' | 'waitingBackup' | 'dirty' | 'savedDraft' | 'backupCandidates' | 'backupCandidatesAria' | 'opening' | 'open' | 'restoring' | 'restore' | 'copying' | 'copyReference' | 'backupHelp' | 'savedAt' | 'previewPaused' | 'filterAria' | 'filterPlaceholder' | 'clear' | 'filterEmpty' | 'filterEmptyHelp' | 'activeMemories' | 'archivedMemories' | 'waitingEntry' | 'waitingEntryHelp' | 'manualAddAria' | 'manualAdd' | 'manualAddHelp' | 'title' | 'titlePlaceholder' | 'tags' | 'tagsPlaceholder' | 'content' | 'contentPlaceholder' | 'addDraft' | 'sensitiveDraft' | 'sensitiveDraftHelp' | 'fileContent' | 'fileActionsAria' | 'saving' | 'save' | 'saved' | 'openFile' | 'openFolder' | 'loading' | 'reload' | 'openPrevious' | 'copyPath' | 'copyPrevious' | 'resetting' | 'resetBackup' | 'restorePrevious' | 'archiveDraftNotice' | 'noMatchEntry' | 'noEntry' | 'created' | 'updated' | 'archivedNoPrompt' | 'activePrompt' | 'locateDraft' | 'promptPreview' | 'willInject' | 'willNotInject' | 'copyContext' | 'promptPreviewHelp' | 'safeModePreview' | 'emptyPromptPreview' | 'loadFailed' | 'reloaded' | 'reloadDiscarded' | 'toggleFailed' | 'agentReadFailed' | 'saveBlocked' | 'safeMode' | 'savedRedacted' | 'savedFile' | 'saveFailed' | 'resetDone' | 'resetDoneDetail' | 'resetFailed' | 'noBackup' | 'noBackupDetail' | 'restoreLatestTitle' | 'restoreCandidateTitle' | 'confirmRestore' | 'cancel' | 'restoredLatest' | 'restoredCandidate' | 'restoredDetail' | 'restoreFailed' | 'restoreLatestFailed' | 'restoreCandidateFailed' | 'openFailed' | 'openPreviousFailed' | 'pathCopied' | 'copyFailed' | 'copyFailedDetail' | 'backupReferenceCopied' | 'entryReferenceCopied' | 'locateFailed' | 'locateFailedDetail' | 'emptyTitle' | 'emptyTitleDetail' | 'emptyContent' | 'emptyContentDetail' | 'draftOversize' | 'oversizeDetail' | 'addedDraft' | 'addedDraftDetail' | 'updateFailed' | 'invalidIdDetail' | 'archivedDraft' | 'restoredDraft' | 'updateBlocked' | 'archived' | 'restored' | 'archiveFailed' | 'entryRestoreFailed' | 'promptCopied' | 'promptCopiedDetail' | 'restoreDraftAction' | 'archiveDraftAction' | 'restoreAction' | 'archiveAction';
export type MemorySettingsCopy = {
  intlLocale: string;
  text: Record<MemoryTextKey, string>;
  origins: Record<NonNullable<LocalMemoryState['latestEntry']>['origin'], string>;
  entryStatuses: Record<LocalMemoryState['entries'][number]['status'], string>;
  backupKinds: Record<NonNullable<LocalMemoryState['latestBackup']>['kind'], string>;
  memoryStatuses: Record<LocalMemoryState['status'], string>;
  promptBlocked: {
    disabled: string;
    incognito: string;
    safeMode: string;
    agentRead: string;
  };
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
  localFile: '本地 MEMORY.md',
  localFileHelp: '透明 Markdown 文件，保存在当前本机工作区。这里的内容不会自动从聊天里抽取。',
  enableLocalFile: '启用本地 MEMORY.md',
  agentReadable: '模型上下文可读取',
  agentReadableHelp: '默认关闭。开启后，发送消息时会把本地记忆一并提供给模型；隐身模式下仍然不提供。',
  enableAgentRead: '允许模型上下文读取本地记忆',
  waitingFile: '等待创建 MEMORY.md',
  waitingBackup: '等待生成上一版备份',
  dirty: '有未保存修改',
  savedDraft: '草稿已保存',
  backupCandidates: '备份候选',
  backupCandidatesAria: '本地记忆备份候选列表',
  opening: '打开中…',
  open: '打开',
  restoring: '恢复中…',
  restore: '恢复',
  copying: '复制中…',
  copyReference: '复制引用',
  backupHelp: '上一版操作会使用最近的候选；这里只显示 metadata，不展示备份正文。',
  savedAt: '保存于 ',
  previewPaused: '草稿条目预览暂停',
  filterAria: '筛选本地记忆',
  filterPlaceholder: '筛选标题、内容、ID 或标签',
  clear: '清除',
  filterEmpty: '没有匹配的记忆条目',
  filterEmptyHelp: '筛选不会修改 MEMORY.md；清除筛选后会恢复显示全部条目。',
  activeMemories: '生效记忆',
  archivedMemories: '已归档记忆',
  waitingEntry: '等待添加记忆条目',
  waitingEntryHelp: '在任务里确认记忆，或点右上角「添加记忆」。',
  manualAddAria: '手动添加本地记忆',
  manualAdd: '手动添加记忆',
  manualAddHelp: '填写后立即写入本机 MEMORY.md。',
  title: '记忆标题',
  titlePlaceholder: '标题',
  tags: '记忆标签',
  tagsPlaceholder: '标签（逗号分隔，可选）',
  content: '记忆内容',
  contentPlaceholder: '内容',
  addDraft: '添加记忆',
  sensitiveDraft: '草稿含疑似敏感字段',
  sensitiveDraftHelp: '保存时会先遮蔽疑似 token、API key 或密码，再写入 MEMORY.md。',
  fileContent: 'MEMORY.md 内容',
  fileActionsAria: 'MEMORY.md 文件操作',
  saving: '保存中…',
  save: '保存',
  saved: '已保存',
  openFile: '打开 MEMORY.md',
  openFolder: '打开所在目录',
  loading: '载入中…',
  reload: '重新载入',
  openPrevious: '打开上一版',
  copyPath: '复制路径',
  copyPrevious: '复制上一版引用',
  resetting: '重置中…',
  resetBackup: '重置并备份',
  restorePrevious: '恢复上一版',
  archiveDraftNotice: '当前归档/恢复操作只更新草稿，保存后才会写入 MEMORY.md。',
  noMatchEntry: '无匹配条目。',
  noEntry: '暂无条目。',
  created: '创建 ',
  updated: '更新 ',
  archivedNoPrompt: '已归档，不会提供给模型',
  activePrompt: '生效条目，发送时会提供给模型',
  locateDraft: '定位草稿',
  promptPreview: '模型上下文预览',
  willInject: '发送时会提供',
  willNotInject: '当前不会提供',
  copyContext: '复制上下文',
  promptPreviewHelp: '这里是发送时会提供给模型的内容；已归档条目不在其中，疑似密钥会遮蔽。',
  safeModePreview: 'MEMORY.md 过大，当前不会生成模型上下文预览。',
  emptyPromptPreview: '没有生效记忆会提供给模型。',
  loadFailed: '载入本地记忆失败',
  reloaded: '已重新载入 MEMORY.md',
  reloadDiscarded: '未保存的草稿修改已丢弃。',
  toggleFailed: '更新本地记忆开关失败',
  agentReadFailed: '更新模型读取权限失败',
  saveBlocked: '保存被拦截',
  safeMode: 'MEMORY.md 内容过大，已进入安全模式。',
  savedRedacted: '已保存并遮蔽敏感字段',
  savedFile: '已保存 MEMORY.md',
  saveFailed: '保存 MEMORY.md 失败',
  resetDone: '已重置 MEMORY.md',
  resetDoneDetail: '上一版已保存为备份文件。',
  resetFailed: '重置 MEMORY.md 失败',
  noBackup: '没有可恢复备份',
  noBackupDetail: '保存或重置 MEMORY.md 后才会生成上一版备份。',
  restoreLatestTitle: '恢复上一版 MEMORY.md？',
  restoreCandidateTitle: '恢复这个 MEMORY.md 备份？',
  confirmRestore: '恢复',
  cancel: '取消',
  restoredLatest: '已恢复上一版 MEMORY.md',
  restoredCandidate: '已恢复 MEMORY.md 备份候选',
  restoredDetail: '恢复前的当前文件已保存为 restore.bak。',
  restoreFailed: '恢复失败',
  restoreLatestFailed: '恢复上一版失败',
  restoreCandidateFailed: '恢复备份失败',
  openFailed: '打开失败',
  openPreviousFailed: '打开上一版失败',
  pathCopied: '已复制路径',
  copyFailed: '复制失败',
  copyFailedDetail: '剪贴板不可用或被系统拒绝。',
  backupReferenceCopied: '已复制上一版引用',
  entryReferenceCopied: '已复制记忆引用',
  locateFailed: '无法定位记忆',
  locateFailedDetail: '当前草稿里找不到这条记忆；请先保存或刷新后重试。',
  emptyTitle: '标题不能为空',
  emptyTitleDetail: '给这条记忆起一个短标题。',
  emptyContent: '内容不能为空',
  emptyContentDetail: '写下要保留的偏好或事实。',
  draftOversize: '草稿过大',
  oversizeDetail: 'MEMORY.md 超出安全上限，请先删减旧内容。',
  addedDraft: '已添加记忆',
  addedDraftDetail: '已写入 MEMORY.md。',
  updateFailed: '无法更新记忆',
  invalidIdDetail: '这条记忆没有可识别 ID，已停止更新。',
  archivedDraft: '已在草稿中归档记忆',
  restoredDraft: '已在草稿中恢复记忆',
  updateBlocked: '更新被拦截',
  archived: '已归档记忆',
  restored: '已恢复记忆',
  archiveFailed: '归档记忆失败',
  entryRestoreFailed: '恢复记忆失败',
  promptCopied: '已复制模型上下文预览',
  promptCopiedDetail: '使用同一条 prompt 预览和遮蔽路径。',
  restoreDraftAction: '恢复到草稿',
  archiveDraftAction: '归档到草稿',
  restoreAction: '恢复',
  archiveAction: '归档'
} satisfies Record<MemoryTextKey, string>;
const enText = {
  localFile: 'Local MEMORY.md',
  localFileHelp: 'A transparent Markdown file stored in the current local workspace. Content is never extracted from chats automatically.',
  enableLocalFile: 'Enable local MEMORY.md',
  agentReadable: 'Available to model context',
  agentReadableHelp: 'Off by default. When enabled, local memory is given to the model along with your message; incognito mode still withholds it.',
  enableAgentRead: 'Allow model context to read local memory',
  waitingFile: 'Waiting to create MEMORY.md',
  waitingBackup: 'Waiting to create a previous-version backup',
  dirty: 'Unsaved changes',
  savedDraft: 'Draft saved',
  backupCandidates: 'Backup candidates',
  backupCandidatesAria: 'Local memory backup candidates',
  opening: 'Opening…',
  open: 'Open',
  restoring: 'Restoring…',
  restore: 'Restore',
  copying: 'Copying…',
  copyReference: 'Copy reference',
  backupHelp: 'Previous-version actions use the latest candidate. Only metadata is shown here, never backup contents.',
  savedAt: 'Saved ',
  previewPaused: 'Draft entry preview paused',
  filterAria: 'Filter local memory',
  filterPlaceholder: 'Filter title, content, ID, or tags',
  clear: 'Clear',
  filterEmpty: 'No matching memory entries',
  filterEmptyHelp: 'Filtering does not modify MEMORY.md. Clear the filter to show all entries.',
  activeMemories: 'Active memories',
  archivedMemories: 'Archived memories',
  waitingEntry: 'Ready to add a memory entry',
  waitingEntryHelp: 'Confirm a memory in chat, or use "Add memory" above.',
  manualAddAria: 'Add local memory manually',
  manualAdd: 'Add memory manually',
  manualAddHelp: 'Written to the local MEMORY.md immediately.',
  title: 'Memory title',
  titlePlaceholder: 'Title',
  tags: 'Memory tags',
  tagsPlaceholder: 'Tags (comma-separated, optional)',
  content: 'Memory content',
  contentPlaceholder: 'Content',
  addDraft: 'Add memory',
  sensitiveDraft: 'Draft may contain sensitive fields',
  sensitiveDraftHelp: 'Suspected tokens, API keys, and passwords are redacted before MEMORY.md is written.',
  fileContent: 'MEMORY.md content',
  fileActionsAria: 'MEMORY.md file actions',
  saving: 'Saving…',
  save: 'Save',
  saved: 'Saved',
  openFile: 'Open MEMORY.md',
  openFolder: 'Open containing folder',
  loading: 'Loading…',
  reload: 'Reload',
  openPrevious: 'Open previous version',
  copyPath: 'Copy path',
  copyPrevious: 'Copy previous-version reference',
  resetting: 'Resetting…',
  resetBackup: 'Reset and back up',
  restorePrevious: 'Restore previous version',
  archiveDraftNotice: 'Archive and restore actions update only the draft until you save MEMORY.md.',
  noMatchEntry: 'No matching entries.',
  noEntry: 'No entries yet.',
  created: 'Created ',
  updated: 'Updated ',
  archivedNoPrompt: 'Archived; not given to the model',
  activePrompt: 'Active entry; given to the model when you send',
  locateDraft: 'Locate in draft',
  promptPreview: 'Model context preview',
  willInject: 'Included when sending',
  willNotInject: 'Not currently included',
  copyContext: 'Copy context',
  promptPreviewHelp: 'What will be given to the model when you send. Archived entries are excluded and suspected secrets are redacted.',
  safeModePreview: 'MEMORY.md is too large, so no model-context preview is generated.',
  emptyPromptPreview: 'No active memories will be given to the model.',
  loadFailed: 'Failed to load local memory',
  reloaded: 'MEMORY.md reloaded',
  reloadDiscarded: 'Unsaved draft changes were discarded.',
  toggleFailed: 'Failed to update local memory',
  agentReadFailed: 'Failed to update model read access',
  saveBlocked: 'Save blocked',
  safeMode: 'MEMORY.md is too large and entered safe mode.',
  savedRedacted: 'Saved with sensitive fields redacted',
  savedFile: 'MEMORY.md saved',
  saveFailed: 'Failed to save MEMORY.md',
  resetDone: 'MEMORY.md reset',
  resetDoneDetail: 'The previous version was saved as a backup.',
  resetFailed: 'Failed to reset MEMORY.md',
  noBackup: 'No backup available to restore',
  noBackupDetail: 'A previous-version backup is created after you save or reset MEMORY.md.',
  restoreLatestTitle: 'Restore the previous MEMORY.md version?',
  restoreCandidateTitle: 'Restore this MEMORY.md backup?',
  confirmRestore: 'Restore',
  cancel: 'Cancel',
  restoredLatest: 'Previous MEMORY.md version restored',
  restoredCandidate: 'MEMORY.md backup candidate restored',
  restoredDetail: 'The file from before the restore was saved as restore.bak.',
  restoreFailed: 'Restore failed',
  restoreLatestFailed: 'Failed to restore previous version',
  restoreCandidateFailed: 'Failed to restore backup',
  openFailed: 'Open failed',
  openPreviousFailed: 'Failed to open previous version',
  pathCopied: 'Path copied',
  copyFailed: 'Copy failed',
  copyFailedDetail: 'The clipboard is unavailable or access was denied by the system.',
  backupReferenceCopied: 'Previous-version reference copied',
  entryReferenceCopied: 'Memory reference copied',
  locateFailed: 'Could not locate memory',
  locateFailedDetail: 'This memory is not in the current draft. Save or reload, then try again.',
  emptyTitle: 'Title is required',
  emptyTitleDetail: 'Give this memory a short title.',
  emptyContent: 'Content is required',
  emptyContentDetail: 'Enter the preference or fact to retain.',
  draftOversize: 'Draft is too large',
  oversizeDetail: 'MEMORY.md exceeds the safety limit. Remove older content first.',
  addedDraft: 'Memory added',
  addedDraftDetail: 'Written to MEMORY.md.',
  updateFailed: 'Could not update memory',
  invalidIdDetail: 'This memory has no recognizable ID, so the update was stopped.',
  archivedDraft: 'Memory archived in draft',
  restoredDraft: 'Memory restored in draft',
  updateBlocked: 'Update blocked',
  archived: 'Memory archived',
  restored: 'Memory restored',
  archiveFailed: 'Failed to archive memory',
  entryRestoreFailed: 'Failed to restore memory',
  promptCopied: 'Model context preview copied',
  promptCopiedDetail: 'Uses the same prompt-preview and redaction path.',
  restoreDraftAction: 'Restore to draft',
  archiveDraftAction: 'Archive in draft',
  restoreAction: 'Restore',
  archiveAction: 'Archive'
} satisfies Record<MemoryTextKey, string>;
const SETTINGS_MEMORY_COPY_BASE = {
  zh: makeCopy('zh-CN', zhText, {
    origins: {
      manual: '手动记录',
      imported: '导入记录',
      extracted: '确认提取',
      unknown: '手写条目'
    },
    entryStatuses: {
      draft: '草稿',
      review_required: '待确认',
      active: '生效',
      archived: '已归档',
      rejected: '已拒绝',
      unknown: '未识别'
    },
    backupKinds: {
      reset: '重置前备份',
      restore: '恢复前备份',
      save: '保存前备份'
    },
    memoryStatuses: {
      ok: '本地文件已就绪',
      disabled: '已关闭',
      safe_mode: '安全模式',
      incognito_blocked: '隐身禁用',
      error: '读取失败'
    },
    promptBlocked: {
      disabled: '本地记忆已关闭。',
      incognito: '隐身模式下不会提供本地记忆。',
      safeMode: 'MEMORY.md 过大，当前不会提供。',
      agentRead: '模型上下文读取未开启。'
    },
    backupOversize: '备份过大，无法预览条目',
    previewOversize: '草稿过大，条目预览已暂停；保存前请先删减 MEMORY.md 内容。',
    previewTruncationMarker: '[本地记忆已按长度截断]'
  }),
  en: makeCopy('en-US', enText, {
    origins: {
      manual: 'Manual entry',
      imported: 'Imported entry',
      extracted: 'Confirmed extraction',
      unknown: 'Handwritten entry'
    },
    entryStatuses: {
      draft: 'Draft',
      review_required: 'Needs review',
      active: 'Active',
      archived: 'Archived',
      rejected: 'Rejected',
      unknown: 'Unrecognized'
    },
    backupKinds: {
      reset: 'Before reset',
      restore: 'Before restore',
      save: 'Before save'
    },
    memoryStatuses: {
      ok: 'Local file ready',
      disabled: 'Off',
      safe_mode: 'Safe mode',
      incognito_blocked: 'Disabled in incognito',
      error: 'Read failed'
    },
    promptBlocked: {
      disabled: 'Local memory is disabled.',
      incognito: 'Local memory is never added in incognito mode.',
      safeMode: 'MEMORY.md is too large and will not be added.',
      agentRead: 'Model context access is disabled.'
    },
    backupOversize: 'Backup is too large to preview entries',
    previewOversize: 'The draft is too large, so entry preview is paused. Reduce MEMORY.md before saving.',
    previewTruncationMarker: '[Local memory truncated to the length limit]'
  })
};
const koText = {
  localFile: '로컬 MEMORY.md',
  localFileHelp: '현재 로컬 작업 공간에 저장된 투명한 Markdown 파일입니다. 채팅에서 내용이 자동으로 추출되지 않습니다.',
  enableLocalFile: '로컬 MEMORY.md 활성화',
  agentReadable: '모델 컨텍스트에서 사용 가능',
  agentReadableHelp: '기본값은 꺼져 있습니다. 켜면 메시지와 함께 로컬 메모리가 모델에 제공되며, 시크릿 모드에서는 계속 제외됩니다.',
  enableAgentRead: '모델 컨텍스트의 로컬 메모리 읽기 허용',
  waitingFile: 'MEMORY.md 생성 대기 중',
  waitingBackup: '이전 버전 백업 생성 대기 중',
  dirty: '저장되지 않은 변경 사항',
  savedDraft: '초안 저장됨',
  backupCandidates: '백업 후보',
  backupCandidatesAria: '로컬 메모리 백업 후보',
  opening: '여는 중…',
  open: '열기',
  restoring: '복원 중…',
  restore: '복원',
  copying: '복사 중…',
  copyReference: '참조 복사',
  backupHelp: '이전 버전 작업은 최신 후보를 사용합니다. 여기에는 메타데이터만 표시하고 백업 내용은 표시하지 않습니다.',
  savedAt: '저장 시간 ',
  previewPaused: '초안 항목 미리보기 일시 중지됨',
  filterAria: '로컬 메모리 필터',
  filterPlaceholder: '제목, 내용, ID 또는 태그 필터',
  clear: '지우기',
  filterEmpty: '일치하는 메모리 항목이 없습니다',
  filterEmptyHelp: '필터링은 MEMORY.md를 수정하지 않습니다. 필터를 지우면 모든 항목이 표시됩니다.',
  activeMemories: '활성 메모리',
  archivedMemories: '보관된 메모리',
  waitingEntry: '메모리 항목을 추가할 준비가 되었습니다',
  waitingEntryHelp: '채팅에서 메모리를 확인하거나 위의 “메모리 추가”를 사용하세요.',
  manualAddAria: '로컬 메모리 수동 추가',
  manualAdd: '메모리 수동 추가',
  manualAddHelp: '로컬 MEMORY.md에 즉시 기록됩니다.',
  title: '메모리 제목',
  titlePlaceholder: '제목',
  tags: '메모리 태그',
  tagsPlaceholder: '태그(쉼표로 구분, 선택 사항)',
  content: '메모리 내용',
  contentPlaceholder: '내용',
  addDraft: '메모리 추가',
  sensitiveDraft: '초안에 민감한 필드가 포함될 수 있음',
  sensitiveDraftHelp: 'MEMORY.md에 기록하기 전에 의심되는 토큰, API 키 및 비밀번호가 가려집니다.',
  fileContent: 'MEMORY.md 내용',
  fileActionsAria: 'MEMORY.md 파일 작업',
  saving: '저장 중…',
  save: '저장',
  saved: '저장됨',
  openFile: 'MEMORY.md 열기',
  openFolder: '포함된 폴더 열기',
  loading: '로드 중…',
  reload: '새로 고침',
  openPrevious: '이전 버전 열기',
  copyPath: '경로 복사',
  copyPrevious: '이전 버전 참조 복사',
  resetting: '초기화 중…',
  resetBackup: '초기화 및 백업',
  restorePrevious: '이전 버전 복원',
  archiveDraftNotice: '보관 및 복원 작업은 MEMORY.md를 저장할 때까지 초안만 업데이트합니다.',
  noMatchEntry: '일치하는 항목이 없습니다.',
  noEntry: '아직 항목이 없습니다.',
  created: '생성 시간 ',
  updated: '업데이트 시간 ',
  archivedNoPrompt: '보관됨; 모델에 제공되지 않음',
  activePrompt: '활성 항목; 전송할 때 모델에 제공됨',
  locateDraft: '초안에서 찾기',
  promptPreview: '모델 컨텍스트 미리보기',
  willInject: '전송 시 포함됨',
  willNotInject: '현재 포함되지 않음',
  copyContext: '컨텍스트 복사',
  promptPreviewHelp: '전송할 때 모델에 제공되는 내용입니다. 보관된 항목은 제외되고 의심되는 비밀 정보는 가려집니다.',
  safeModePreview: 'MEMORY.md가 너무 커서 모델 컨텍스트 미리보기를 생성하지 않습니다.',
  emptyPromptPreview: '활성 메모리가 모델에 제공되지 않습니다.',
  loadFailed: '로컬 메모리를 로드하지 못했습니다',
  reloaded: 'MEMORY.md를 다시 로드했습니다',
  reloadDiscarded: '저장하지 않은 초안 변경 사항을 버렸습니다.',
  toggleFailed: '로컬 메모리를 업데이트하지 못했습니다',
  agentReadFailed: '모델 읽기 권한을 업데이트하지 못했습니다',
  saveBlocked: '저장이 차단됨',
  safeMode: 'MEMORY.md가 너무 커서 안전 모드로 전환되었습니다.',
  savedRedacted: '민감한 필드를 가리고 저장됨',
  savedFile: 'MEMORY.md 저장됨',
  saveFailed: 'MEMORY.md를 저장하지 못했습니다',
  resetDone: 'MEMORY.md 초기화됨',
  resetDoneDetail: '이전 버전이 백업 파일로 저장되었습니다.',
  resetFailed: 'MEMORY.md를 초기화하지 못했습니다',
  noBackup: '복원할 수 있는 백업이 없습니다',
  noBackupDetail: 'MEMORY.md를 저장하거나 초기화한 후 이전 버전 백업이 생성됩니다.',
  restoreLatestTitle: '이전 MEMORY.md 버전을 복원하시겠습니까?',
  restoreCandidateTitle: '이 MEMORY.md 백업을 복원하시겠습니까?',
  confirmRestore: '복원',
  cancel: '취소',
  restoredLatest: '이전 MEMORY.md 버전이 복원됨',
  restoredCandidate: 'MEMORY.md 백업 후보가 복원됨',
  restoredDetail: '복원 전 파일은 restore.bak으로 저장되었습니다.',
  restoreFailed: '복원하지 못했습니다',
  restoreLatestFailed: '이전 버전을 복원하지 못했습니다',
  restoreCandidateFailed: '백업을 복원하지 못했습니다',
  openFailed: '열지 못했습니다',
  openPreviousFailed: '이전 버전을 열지 못했습니다',
  pathCopied: '경로 복사됨',
  copyFailed: '복사하지 못했습니다',
  copyFailedDetail: '클립보드를 사용할 수 없거나 시스템에서 액세스가 거부되었습니다.',
  backupReferenceCopied: '이전 버전 참조 복사됨',
  entryReferenceCopied: '메모리 참조 복사됨',
  locateFailed: '메모리를 찾지 못했습니다',
  locateFailedDetail: '현재 초안에 이 메모리가 없습니다. 저장하거나 다시 로드한 후 시도하세요.',
  emptyTitle: '제목이 필요합니다',
  emptyTitleDetail: '이 메모리에 짧은 제목을 지정하세요.',
  emptyContent: '내용이 필요합니다',
  emptyContentDetail: '보관할 선호 사항이나 사실을 입력하세요.',
  draftOversize: '초안이 너무 큽니다',
  oversizeDetail: 'MEMORY.md가 안전 한도를 초과했습니다. 먼저 오래된 내용을 삭제하세요.',
  addedDraft: '메모리 추가됨',
  addedDraftDetail: 'MEMORY.md에 기록되었습니다.',
  updateFailed: '메모리를 업데이트하지 못했습니다',
  invalidIdDetail: '이 메모리에 인식 가능한 ID가 없어 업데이트를 중지했습니다.',
  archivedDraft: '초안에서 메모리 보관됨',
  restoredDraft: '초안에서 메모리 복원됨',
  updateBlocked: '업데이트가 차단됨',
  archived: '메모리 보관됨',
  restored: '메모리 복원됨',
  archiveFailed: '메모리를 보관하지 못했습니다',
  entryRestoreFailed: '메모리를 복원하지 못했습니다',
  promptCopied: '모델 컨텍스트 미리보기 복사됨',
  promptCopiedDetail: '동일한 프롬프트 미리보기 및 비밀 정보 제거 경로를 사용합니다.',
  restoreDraftAction: '초안으로 복원',
  archiveDraftAction: '초안에서 보관',
  restoreAction: '복원',
  archiveAction: '보관'
} satisfies Record<MemoryTextKey, string>;
const SETTINGS_MEMORY_COPY = {
  ...SETTINGS_MEMORY_COPY_BASE,
  ko: {
    ...makeCopy('ko-KR', koText, {
      origins: {
        manual: '수동 입력',
        imported: '가져온 항목',
        extracted: '추출 확인됨',
        unknown: '직접 작성한 항목'
      },
      entryStatuses: {
        draft: '초안',
        review_required: '검토 필요',
        active: '활성',
        archived: '보관됨',
        rejected: '거부됨',
        unknown: '인식할 수 없음'
      },
      backupKinds: {
        reset: '초기화 전',
        restore: '복원 전',
        save: '저장 전'
      },
      memoryStatuses: {
        ok: '로컬 파일 준비됨',
        disabled: '꺼짐',
        safe_mode: '안전 모드',
        incognito_blocked: '시크릿 모드에서 비활성화됨',
        error: '읽기 실패'
      },
      promptBlocked: {
        disabled: '로컬 메모리가 비활성화되었습니다.',
        incognito: '시크릿 모드에서는 로컬 메모리가 추가되지 않습니다.',
        safeMode: 'MEMORY.md가 너무 커서 추가되지 않습니다.',
        agentRead: '모델 컨텍스트 액세스가 비활성화되었습니다.'
      },
      backupOversize: '백업이 너무 커서 항목을 미리 볼 수 없습니다',
      previewOversize: '초안이 너무 커서 항목 미리보기를 일시 중지했습니다. 저장하기 전에 MEMORY.md를 줄이세요.',
      previewTruncationMarker: '[로컬 메모리가 길이 제한에 맞게 잘림]'
    }),
    intlLocale: 'ko-KR'
  }
} satisfies UiCatalog<MemorySettingsCopy>;
export function getMemorySettingsCopy(locale: UiLocale): MemorySettingsCopy {
  return SETTINGS_MEMORY_COPY[locale];
}
function makeCopy(intlLocale: string, text: Record<MemoryTextKey, string>, values: Pick<MemorySettingsCopy, 'origins' | 'entryStatuses' | 'backupKinds' | 'memoryStatuses' | 'promptBlocked' | 'backupOversize' | 'previewOversize' | 'previewTruncationMarker'>): MemorySettingsCopy {
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const isZh = intlLocale === 'zh-CN';
  const isKo = intlLocale === 'ko-KR';
  return {
    intlLocale,
    text,
    ...values,
    countActive: (count, draft) => isZh ? `${draft ? '草稿 ' : ''}${count} 条生效` : isKo ? `${draft ? '초안 · ' : ''}${count}개 활성 항목` : `${draft ? 'Draft · ' : ''}${plural(count, 'active entry', 'active entries')}`,
    countArchived: (count, draft) => isZh ? `${draft ? '草稿 ' : ''}${count} 条已归档` : isKo ? `${draft ? '초안 · ' : ''}${count}개 보관 항목` : `${draft ? 'Draft · ' : ''}${plural(count, 'archived entry', 'archived entries')}`,
    saveSummary: (active, archived) => isZh ? `当前 ${active} 条生效${archived > 0 ? ` / ${archived} 条已归档` : ''}；已保留上一版备份。` : isKo ? `활성 ${active}개${archived > 0 ? ` / 보관 ${archived}개` : ''}; 이전 버전이 백업되었습니다.` : `${plural(active, 'active entry', 'active entries')}${archived > 0 ? ` / ${plural(archived, 'archived entry', 'archived entries')}` : ''}; the previous version was backed up.`,
    backupSummary: (active, archived) => isZh ? `${active} 条生效${archived > 0 ? ` / ${archived} 条已归档` : ''}` : isKo ? `활성 ${active}개${archived > 0 ? ` / 보관 ${archived}개` : ''}` : `${plural(active, 'active entry', 'active entries')}${archived > 0 ? ` / ${plural(archived, 'archived entry', 'archived entries')}` : ''}`,
    countEntries: count => isZh ? `${count} 条记忆` : isKo ? `${count}개 메모리` : plural(count, 'memory', 'memories'),
    countMatches: (filtered, total) => isZh ? `${filtered} / ${total} 条匹配` : isKo ? `${filtered} / ${total}개 일치` : `${filtered} / ${total} matching`,
    listAria: title => isZh ? `${title}列表` : isKo ? `${title} 목록` : `${title} list`,
    entryActionsAria: title => isZh ? `${title} 记忆操作` : isKo ? `${title} 메모리 작업` : `${title} memory actions`,
    entryActionAria: (action, identity) => isZh ? `${action}：${identity}` : isKo ? `${action}: ${identity}` : `${action}: ${identity}`,
    openBackupAria: label => isZh ? `打开备份候选 ${label}` : isKo ? `백업 후보 ${label} 열기` : `Open backup candidate ${label}`,
    restoreBackupAria: label => isZh ? `恢复备份候选 ${label}` : isKo ? `백업 후보 ${label} 복원` : `Restore backup candidate ${label}`,
    copyBackupAria: label => isZh ? `复制备份候选引用 ${label}` : isKo ? `백업 후보 참조 ${label} 복사` : `Copy backup candidate reference ${label}`,
    draftStatusAria: action => isZh ? `${action}，保存前不会写入 MEMORY.md` : isKo ? `${action}; 저장하기 전에는 MEMORY.md에 기록되지 않습니다` : `${action}; MEMORY.md is not written until you save`,
    restoreLatestDescription: label => isZh ? `会先备份当前 MEMORY.md，再用最近一次备份覆盖当前文件。将恢复：${label}` : isKo ? `현재 MEMORY.md를 먼저 백업한 후 최신 백업으로 덮어씁니다. 복원 항목: ${label}` : `The current MEMORY.md will be backed up before the latest backup replaces it. Restore: ${label}`,
    restoreCandidateDescription: label => isZh ? `会先备份当前 MEMORY.md，再用选中的备份覆盖当前文件。将恢复：${label}` : isKo ? `현재 MEMORY.md를 먼저 백업한 후 선택한 백업으로 덮어씁니다. 복원 항목: ${label}` : `The current MEMORY.md will be backed up before the selected backup replaces it. Restore: ${label}`,
    redactedDetail: summary => isZh ? `写入前已替换疑似 token、API key 或密码；${summary}` : isKo ? `기록 전에 의심스러운 token, API 키 또는 비밀번호를 가렸습니다; ${summary}` : `Suspected tokens, API keys, or passwords were redacted before writing; ${summary}`,
    openBackupFailed: kind => isZh ? `打开${kind}失败` : isKo ? `${kind}을(를) 열 수 없습니다` : `Failed to open ${kind}`,
    previewTruncated: limit => isZh ? `预览已按 ${limit} 字符上限截断` : isKo ? `미리보기가 ${limit}자 제한으로 잘렸습니다` : `Preview truncated at the ${limit}-character limit`,
    previewUsage: (length, limit) => isZh ? `预览 ${length} / ${limit} 字符` : isKo ? `미리보기 ${length} / ${limit}자` : `Preview ${length} / ${limit} characters`,
    previewLimit: limit => isZh ? `prompt 上限 ${limit} 字符` : isKo ? `프롬프트 제한: ${limit}자` : `Prompt limit: ${limit} characters`
  };
}
