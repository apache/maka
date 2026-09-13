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

import type { UiLocale } from '@maka/core/ui-locale';
import type { ComputerHistoryApplication, ComputerHistoryTimelineEntry } from '@maka/core/computer-history';

const EN = {
  title: 'Computer History', local: 'This Mac', refresh: 'Refresh history',
  settings: 'Computer history settings', allDays: 'Recent 30 days', yesterday: 'Yesterday', closeDetail: 'Close activity',
  permissionHelp: 'Recording needs macOS permissions.', repair: 'Check permissions',
  permissions: 'Data & permissions', pause: 'Pause recording', resume: 'Resume recording',
  setup: 'Set up recording', clear: 'Clear history', remove: 'Delete activity',
  clearTitle: 'Permanently delete history?', removeTitle: 'Delete this activity?',
  removeDescription: 'This deletes raw records in this interval, overlapping summaries, and dependent later summaries. For older summary formats, later documents with unknown dependencies may also be deleted. This may include evidence shared with other activities. This cannot be undone.',
  clearDescription: 'The selected period and overlapping summaries will be permanently deleted. This cannot be undone.',
  cancel: 'Cancel', confirm: 'Delete permanently', previous: 'Previous day', next: 'Next day',
  date: 'Activity date', today: 'Today', search: 'Search summaries or apps',
  source: 'Application', allSources: 'All applications', reset: 'Clear filters',
  activities: 'activities', records: 'events', minutes: 'min', list: 'Activity list',
  summaryWaiting: 'Waiting for activity summaries', summaryWaitingHelp: 'Activity summaries appear after each ten-minute recording window is processed.',
  summaryOffHelp: 'Enable model summaries in settings to summarize recorded activity.',
  summaryPausedHelp: 'Resume recording to continue generating activity summaries.',
  summaryStoppedHelp: 'Check recording in settings to collect new activity.',
  summaryBlockedHelp: 'Check recording availability and permissions in settings.',
  summaryErrorHelp: 'No summary is available yet. Retry above or check the analysis model in settings.',
  firstRun: 'Start recording your activity', firstHelp: 'Choose recording sources and permissions in settings. Text capture and model analysis are separately controlled.',
  noMatch: 'No matching activities', noMatchHelp: 'Try another search or application.',
  loading: 'Loading history', failed: 'History could not be refreshed',
  select: 'Select an activity', selectHelp: 'Activity details and retained evidence appear here.',
  back: 'Back to activities', evidence: 'Recorded events', sources: 'Applications & windows',
  evidenceHelp: 'Observed events are not proof that an action succeeded.',
  modelNote: 'Model-generated summary. Check the recorded evidence before relying on it.',
  modelSummary: 'Model summary', rawGroup: 'Recorded activity', summaryOff: 'Model summaries off',
  summaryIdle: 'Model summaries on', summaryRunning: 'Generating summary', summaryError: 'Summary failed',
  retry: 'Retry summary', addToChat: 'Add to chat draft', draftTitle: 'Review chat draft',
  draftLabel: 'Draft', draftHelp: 'Only this draft is added to chat. Nothing is sent until you send the message.',
  insert: 'Add draft', suggestion: 'Workflow suggestion', viewSuggestion: 'Review suggestion',
  expired: 'Raw evidence is no longer available', expiredHelp: 'Raw events are retained for 48 hours. Saved summaries remain until you delete them.',
  missing: 'This activity is no longer available', detailFailed: 'Evidence could not be loaded',
  retained: 'Raw events: 48 hours', summariesRetained: 'Summaries: until deleted',
  shown: 'shown', total: 'retained', noWindows: 'No retained window titles',
  showMore: 'Show more events', showLess: 'Show fewer events',
  evidenceDisclosure: 'Recorded evidence', iconsFailed: 'Application icons could not be loaded',
  document: 'Summary document', documentMode: 'Document view', rendered: 'Preview', sourceCode: 'Source',
  activitySummary: 'Activity summary', documentInfo: 'Summary file information', storedFilename: 'Stored filename',
  copyFilename: 'Copy filename', copyMarkdown: 'Copy full Markdown', revealInFinder: 'Reveal in Finder',
  filenameCopied: 'Filename copied', markdownCopied: 'Full Markdown copied', copyFailed: 'Could not copy', revealFailed: 'Could not reveal summary in Finder',
  documentFailed: 'Summary document could not be loaded', noDocument: 'No model summary has been saved for this activity.',
  excluded: 'Excluded from future recording', exclude: 'Exclude application', include: 'Allow application',
  period: { last_10_minutes: 'Last 10 minutes', last_hour: 'Last hour', today: 'Today', all: 'All history' },
  states: {
    unsupported: 'Unsupported platform', stopped: 'Recording off', running: 'Recording',
    paused: 'Recording paused', needs_permission: 'Permissions needed', unavailable: 'Collector unavailable', error: 'Recording error',
  },
  eventKinds: {
    'session.started': 'Recording started', 'session.ended': 'Recording ended',
    'window.changed': 'Window changed', 'ui.changed': 'Content updated', 'mouse.click': 'Click', 'mouse.drag': 'Drag',
    'mouse.context_menu': 'Context menu', 'keyboard.text_input': 'Text input',
    'keyboard.submit': 'Submit key', 'keyboard.shortcut': 'Keyboard shortcut',
    'terminal.value_changed': 'Terminal changed', 'selection.changed': 'Selection changed', 'debug.error': 'Recorder diagnostic',
  } as Record<string, string>,
};

type Copy = typeof EN;

const ZH: Copy = {
  title: '电脑历史', local: '此 Mac', refresh: '刷新历史',
  settings: '电脑历史设置', allDays: '最近 30 天', yesterday: '昨天', closeDetail: '关闭活动详情',
  permissionHelp: '记录需要 macOS 权限。', repair: '检查权限',
  permissions: '数据与权限', pause: '暂停记录', resume: '恢复记录',
  setup: '设置记录', clear: '清除历史', remove: '删除此活动',
  clearTitle: '永久删除历史记录？', removeTitle: '删除这段活动？',
  removeDescription: '将删除这段时间的原始记录、重叠摘要及依赖它们的后续摘要。旧版摘要中，依赖关系不明的后续文档也可能被删除。删除范围可能包含其他活动共用的证据。此操作无法撤销。',
  clearDescription: '将永久删除所选时段的记录及重叠摘要。此操作无法撤销。',
  cancel: '取消', confirm: '永久删除', previous: '前一天', next: '后一天',
  date: '活动日期', today: '今天', search: '搜索摘要或应用',
  source: '应用来源', allSources: '所有应用', reset: '清除筛选',
  activities: '段活动', records: '条事件', minutes: '分钟', list: '活动列表',
  summaryWaiting: '等待活动摘要', summaryWaitingHelp: '每段十分钟的记录完成整理后，摘要会显示在这里。',
  summaryOffHelp: '在设置中开启模型摘要后，即可整理已采集的活动。',
  summaryPausedHelp: '恢复记录后将继续生成活动摘要。',
  summaryStoppedHelp: '前往设置检查采集状态，以记录新的活动。',
  summaryBlockedHelp: '请前往设置检查采集状态与权限。',
  summaryErrorHelp: '尚未生成可用摘要。可在上方重试，或前往设置检查分析模型。',
  firstRun: '开始记录电脑活动', firstHelp: '前往设置选择记录来源和权限。文本采集与模型分析由你分别决定。',
  noMatch: '没有匹配的活动', noMatchHelp: '试试其他关键词或应用来源。',
  loading: '正在读取历史', failed: '历史记录刷新失败',
  select: '选择一段活动', selectHelp: '在这里查看活动详情和保留的原始证据。',
  back: '返回活动列表', evidence: '原始事件', sources: '应用与窗口',
  evidenceHelp: '事件只表示观察到的交互，不代表操作已成功。',
  modelNote: '摘要由模型生成，请结合原始事件核对。',
  modelSummary: '模型摘要', rawGroup: '记录的活动', summaryOff: '模型摘要已关闭',
  summaryIdle: '模型摘要已开启', summaryRunning: '正在生成摘要', summaryError: '摘要生成失败',
  retry: '重试摘要', addToChat: '加入对话草稿', draftTitle: '检查对话草稿',
  draftLabel: '草稿内容', draftHelp: '仅将这份草稿加入对话，发送消息前不会提交给模型。',
  insert: '加入草稿', suggestion: '工作流建议', viewSuggestion: '查看建议',
  expired: '原始证据已不可用', expiredHelp: '原始事件保留 48 小时，已保存的摘要保留至手动删除。',
  missing: '这段活动已不可用', detailFailed: '原始证据读取失败',
  retained: '原始记录保留 48 小时', summariesRetained: '摘要保留至手动删除',
  shown: '条已显示', total: '条仍保留', noWindows: '没有保留的窗口标题',
  showMore: '展开更多事件', showLess: '收起事件',
  evidenceDisclosure: '查看记录依据', iconsFailed: '应用图标加载失败',
  document: '摘要文档', documentMode: '文档视图', rendered: '预览', sourceCode: '源码',
  activitySummary: '活动摘要', documentInfo: '摘要文件信息', storedFilename: '原始文件名',
  copyFilename: '复制文件名', copyMarkdown: '复制完整 Markdown', revealInFinder: '在 Finder 中显示',
  filenameCopied: '已复制文件名', markdownCopied: '已复制完整 Markdown', copyFailed: '复制失败', revealFailed: '无法在 Finder 中显示摘要',
  documentFailed: '摘要文档读取失败', noDocument: '这段活动尚未保存模型摘要。',
  excluded: '已排除后续记录', exclude: '排除此应用', include: '允许记录此应用',
  period: { last_10_minutes: '最近 10 分钟', last_hour: '最近一小时', today: '今天', all: '全部历史' },
  states: {
    unsupported: '当前平台不支持', stopped: '记录已关闭', running: '记录中',
    paused: '记录已暂停', needs_permission: '等待权限', unavailable: '采集器不可用', error: '记录出错',
  },
  eventKinds: {
    'session.started': '开始记录', 'session.ended': '结束记录',
    'window.changed': '切换窗口', 'ui.changed': '内容更新', 'mouse.click': '点击', 'mouse.drag': '拖动',
    'mouse.context_menu': '右键菜单', 'keyboard.text_input': '文本输入',
    'keyboard.submit': '提交按键', 'keyboard.shortcut': '键盘快捷键',
    'terminal.value_changed': '终端变化', 'selection.changed': '选择变化', 'debug.error': '记录诊断',
  },
};

const TW: Copy = {
  title: '電腦歷史', local: '此 Mac', refresh: '重新整理歷史',
  settings: '電腦歷史設定', allDays: '最近 30 天', yesterday: '昨天', closeDetail: '關閉活動詳情',
  permissionHelp: '記錄需要 macOS 權限。', repair: '檢查權限',
  permissions: '資料與權限', pause: '暫停記錄', resume: '恢復記錄',
  setup: '設定記錄', clear: '清除歷史', remove: '刪除此活動',
  clearTitle: '永久刪除歷史記錄？', removeTitle: '刪除這段活動？',
  removeDescription: '將刪除這段時間的原始記錄、重疊摘要及依賴它們的後續摘要。舊版摘要中，依賴關係不明的後續文件也可能被刪除。刪除範圍可能包含其他活動共用的證據。此操作無法復原。',
  clearDescription: '將永久刪除所選時段的記錄及重疊摘要。此操作無法復原。',
  cancel: '取消', confirm: '永久刪除', previous: '前一天', next: '後一天',
  date: '活動日期', today: '今天', search: '搜尋摘要或應用程式',
  source: '應用程式來源', allSources: '所有應用程式', reset: '清除篩選',
  activities: '段活動', records: '筆事件', minutes: '分鐘', list: '活動列表',
  summaryWaiting: '等待活動摘要', summaryWaitingHelp: '每段十分鐘的記錄完成整理後，摘要會顯示在這裡。',
  summaryOffHelp: '在設定中開啟模型摘要後，即可整理已擷取的活動。',
  summaryPausedHelp: '恢復記錄後將繼續產生活動摘要。',
  summaryStoppedHelp: '前往設定檢查擷取狀態，以記錄新的活動。',
  summaryBlockedHelp: '請前往設定檢查擷取狀態與權限。',
  summaryErrorHelp: '尚未產生可用摘要。可在上方重試，或前往設定檢查分析模型。',
  firstRun: '開始記錄電腦活動', firstHelp: '前往設定選擇記錄來源和權限。文字擷取與模型分析由你分別決定。',
  noMatch: '沒有相符的活動', noMatchHelp: '試試其他關鍵字或應用程式來源。',
  loading: '正在讀取歷史', failed: '歷史記錄重新整理失敗',
  select: '選擇一段活動', selectHelp: '在這裡檢視活動詳情和保留的原始證據。',
  back: '返回活動列表', evidence: '原始事件', sources: '應用程式與視窗',
  evidenceHelp: '事件只表示觀察到的互動，不代表操作已成功。',
  modelNote: '摘要由模型產生，請搭配原始事件核對。',
  modelSummary: '模型摘要', rawGroup: '記錄的活動', summaryOff: '模型摘要已關閉',
  summaryIdle: '模型摘要已開啟', summaryRunning: '正在產生摘要', summaryError: '摘要產生失敗',
  retry: '重試摘要', addToChat: '加入對話草稿', draftTitle: '檢查對話草稿',
  draftLabel: '草稿內容', draftHelp: '僅將這份草稿加入對話，傳送訊息前不會提交給模型。',
  insert: '加入草稿', suggestion: '工作流程建議', viewSuggestion: '檢視建議',
  expired: '原始證據已無法取得', expiredHelp: '原始事件保留 48 小時，已儲存的摘要保留至手動刪除。',
  missing: '這段活動已無法取得', detailFailed: '原始證據讀取失敗',
  retained: '原始記錄保留 48 小時', summariesRetained: '摘要保留至手動刪除',
  shown: '筆已顯示', total: '筆仍保留', noWindows: '沒有保留的視窗標題',
  showMore: '展開更多事件', showLess: '收起事件',
  evidenceDisclosure: '檢視記錄依據', iconsFailed: '應用程式圖示載入失敗',
  document: '摘要文件', documentMode: '文件檢視', rendered: '預覽', sourceCode: '原始碼',
  activitySummary: '活動摘要', documentInfo: '摘要檔案資訊', storedFilename: '原始檔名',
  copyFilename: '複製檔名', copyMarkdown: '複製完整 Markdown', revealInFinder: '在 Finder 中顯示',
  filenameCopied: '已複製檔名', markdownCopied: '已複製完整 Markdown', copyFailed: '複製失敗', revealFailed: '無法在 Finder 中顯示摘要',
  documentFailed: '摘要文件讀取失敗', noDocument: '這段活動尚未儲存模型摘要。',
  excluded: '已排除後續記錄', exclude: '排除此應用程式', include: '允許記錄此應用程式',
  period: { last_10_minutes: '最近 10 分鐘', last_hour: '最近一小時', today: '今天', all: '全部歷史' },
  states: {
    unsupported: '目前平台不支援', stopped: '記錄已關閉', running: '記錄中',
    paused: '記錄已暫停', needs_permission: '等待權限', unavailable: '擷取器無法使用', error: '記錄錯誤',
  },
  eventKinds: {
    'session.started': '開始記錄', 'session.ended': '結束記錄',
    'window.changed': '切換視窗', 'ui.changed': '內容更新', 'mouse.click': '點擊', 'mouse.drag': '拖曳',
    'mouse.context_menu': '右鍵選單', 'keyboard.text_input': '文字輸入',
    'keyboard.submit': '提交按鍵', 'keyboard.shortcut': '鍵盤快捷鍵',
    'terminal.value_changed': '終端機變化', 'selection.changed': '選取變化', 'debug.error': '記錄診斷',
  },
};

export function computerHistoryCopy(locale: UiLocale): Copy {
  return locale === 'en' ? EN : locale === 'zh-TW' ? TW : ZH;
}

export function localHistoryDay(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function shiftHistoryDay(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + delta);
  return localHistoryDay(date);
}

export function historyAppName(application: string, ...names: (string | undefined)[]): string {
  return names.find((name) => name && name !== application) || application.split('.').at(-1) || application;
}

export function filterHistoryEntries(
  entries: readonly ComputerHistoryTimelineEntry[], day: string, query: string, source: string,
  applications: ReadonlyMap<string, ComputerHistoryApplication> = new Map(),
): readonly ComputerHistoryTimelineEntry[] {
  const term = query.trim().toLocaleLowerCase();
  return entries.filter((entry) =>
    (!day || localHistoryDay(entry.start) === day)
    && (!source || entry.applications.includes(source))
    && (!term || [entry.title, entry.description, entry.summaryText, ...entry.applications.flatMap((id) => [id, applications.get(id)?.name])].join('\n').toLocaleLowerCase().includes(term)),
  ).sort((a, b) => Date.parse(b.start) - Date.parse(a.start) || a.id.localeCompare(b.id));
}

export function historySuggestionDraft(entry: ComputerHistoryTimelineEntry, locale: UiLocale): string {
  const request = locale === 'en'
    ? 'Review this observed workflow and help me draft a reusable skill or automation. Confirm requirements with me before creating or enabling anything.'
    : locale === 'zh-TW'
      ? '請根據這段活動，協助我起草可重用的技能或自動化。建立或啟用前，請先與我確認需求。'
      : '请根据这段活动，帮我起草可复用的技能或自动化。创建或启用前，请先与我确认需求。';
  // Observed suggestions stay inside the backend-provided untrusted context.
  return `${request}\n\n${entry.contextMarkdown}`;
}
