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
import type { ComputerHistoryClearScope, ComputerHistoryStatus } from '@maka/core/computer-history';

const EN = {
  title: 'Computer history',
  recordingGroup: 'Recording',
  recording: 'Record activity on this Mac',
  recordingHelp: 'Store app names, window titles and interaction metadata locally. Titles may contain sensitive information even with text capture off.',
  accessibility: 'Accessibility',
  inputMonitoring: 'Input Monitoring',
  granted: 'Granted',
  required: 'Not granted',
  permissionHelp: 'Both macOS permissions are required to record activity.',
  request: 'Request macOS permissions',
  requestDone: 'Permission request completed. Grant access in macOS, then return here to check the status.',
  unsupported: 'Recording is available on macOS only.',
  unavailable: 'The recording helper is unavailable.',
  contentGroup: 'Content and analysis',
  text: 'Include text content',
  textHelp: 'Store typed and selected text and accessibility field content locally. This may include private messages and documents. Not required for summaries.',
  analysis: 'Allow model summaries',
  analysisHelp: 'Send sampled app and window metadata to the analysis provider. Token charges may apply. Keyboard text and accessibility field values are not sent for summaries.',
  model: 'Analysis model',
  modelAuthority: 'Uses this Mac’s Daily Review analysis model.',
  modelMissing: 'No analysis model configured',
  modelRequired: 'Configure an analysis model before enabling summaries.',
  configure: 'Configure',
  modelReadFailed: 'Analysis model could not be read.',
  exclusions: 'Excluded sources',
  exclusionsHelp: 'Applies to future recording only. Existing events and summaries remain, and retained events can still be analyzed.',
  protection: 'Detected secure input and private browsing are excluded. Detection is not guaranteed; exclude sensitive sources.',
  applications: 'Applications',
  websites: 'Websites',
  sources: 'Source type',
  recentApps: 'Recently used applications',
  recentAppsHelp: 'Applications found in retained history, not all installed applications.',
  recentAppsFailed: 'Recent applications could not be read. Enter a bundle ID below.',
  selectApp: 'Choose an application',
  applicationID: 'Application bundle ID',
  hostname: 'Website hostname',
  appPlaceholder: 'com.apple.Safari',
  websitePlaceholder: 'example.com',
  websitesHelp: 'Includes subdomains. Requires the browser to expose its current address.',
  appHelp: 'Exact, case-sensitive bundle ID.',
  add: 'Add',
  remove: 'Remove',
  noApps: 'No applications excluded',
  noWebsites: 'No websites excluded',
  invalidApp: 'Enter a bundle ID such as com.apple.Safari, at most 256 characters.',
  invalidWebsite: 'Enter a hostname without a URL, path, port or wildcard.',
  duplicate: 'This source is already excluded.',
  tooMany: 'A maximum of 256 sources can be excluded per category.',
  iconsFailed: 'Application names and icons could not be loaded.',
  data: 'Stored data',
  retention: 'Raw activity retention',
  retentionValue: '48 hours',
  retentionHelp: 'Expired events are hidden immediately and removed while Maka is open. Summaries are stored separately until deleted.',
  events: 'Retained events',
  segments: 'Segments',
  suppressed: 'Suppressed events',
  latest: 'Latest event',
  none: 'None',
  history: 'Open history',
  clear: 'Delete history',
  clearScope: 'Delete period',
  confirmTitle: 'Delete computer history?',
  confirmHelp: 'Removes events and overlapping summaries for the selected period. This cannot be undone.',
  cancel: 'Cancel',
  confirm: 'Delete',
  deleted: 'History deleted.',
  saved: 'Saved.',
  refresh: 'Refresh status',
  loading: 'Loading status…',
  statusReadFailed: 'Computer history status could not be read.',
  actionFailed: 'The change could not be confirmed.',
  local: 'This Mac',
  states: {
    unsupported: 'Unsupported', unavailable: 'Unavailable', needs_permission: 'Permission required',
    stopped: 'Off', running: 'Recording', paused: 'Paused', error: 'Needs attention',
  } satisfies Record<ComputerHistoryStatus['state'], string>,
  periods: {
    last_10_minutes: 'Last 10 minutes', last_hour: 'Last hour', today: 'Today', all: 'All history',
  } satisfies Record<ComputerHistoryClearScope, string>,
};

type Copy = { [K in keyof typeof EN]: (typeof EN)[K] extends string ? string : (typeof EN)[K] };

const COPY: Record<UiLocale, Copy> = {
  en: EN,
  'zh-CN': {
    title: '电脑历史', recordingGroup: '记录', recording: '记录这台 Mac 上的活动',
    recordingHelp: '在本机保存应用名称、窗口标题和交互元数据。关闭文本采集后，窗口标题仍可能包含敏感信息。',
    accessibility: '辅助功能', inputMonitoring: '输入监控', granted: '已授权', required: '未授权',
    permissionHelp: '开始记录需要获得两项 macOS 权限。',
    request: '申请 macOS 权限', requestDone: '已完成权限申请。请在 macOS 中授权，再返回此处确认状态。',
    unsupported: '活动记录仅支持 macOS。', unavailable: '记录辅助程序不可用。',
    contentGroup: '内容与分析', text: '包含文本内容',
    textHelp: '在本机保存输入、选中的文本及辅助功能字段内容，可能包含私信和文档。生成摘要不需要开启此项。',
    analysis: '允许模型生成摘要',
    analysisHelp: '将采样后的应用及窗口元数据发送给分析服务商，可能产生 token 费用。摘要不会发送键盘文本或辅助功能字段内容。',
    model: '分析模型', modelAuthority: '使用这台 Mac 的每日回顾分析模型。', modelMissing: '尚未配置分析模型',
    modelRequired: '请先配置分析模型，再开启摘要。', configure: '配置', modelReadFailed: '无法读取分析模型。',
    exclusions: '排除来源', exclusionsHelp: '仅影响后续记录。已有事件和摘要不会删除，保留的事件仍可参与分析。',
    protection: '已识别的安全输入和无痕浏览会被排除，但识别无法保证覆盖所有情况，请主动排除敏感来源。',
    applications: '应用', websites: '网站', sources: '来源类型',
    recentApps: '最近使用的应用', recentAppsHelp: '来自保留的历史记录，不包含所有已安装应用。',
    recentAppsFailed: '无法读取最近使用的应用，请在下方填写 Bundle ID。', selectApp: '选择应用',
    applicationID: '应用 Bundle ID', hostname: '网站域名',
    appPlaceholder: 'com.apple.Safari', websitePlaceholder: 'example.com', websitesHelp: '包括子域名，依赖浏览器提供当前地址。',
    appHelp: '填写完整 Bundle ID，区分大小写。', add: '添加', remove: '移除', noApps: '未排除任何应用', noWebsites: '未排除任何网站',
    invalidApp: '请输入应用 Bundle ID，例如 com.apple.Safari，最多 256 个字符。',
    invalidWebsite: '请输入域名，不要包含协议、路径、端口或通配符。', duplicate: '此来源已被排除。',
    tooMany: '每类最多排除 256 个来源。', iconsFailed: '无法加载应用名称和图标。',
    data: '已存储数据', retention: '原始活动保留时间', retentionValue: '48 小时',
    retentionHelp: '过期事件会立即隐藏，并在 Maka 运行时清理。摘要独立保存，直至手动删除。',
    events: '保留事件', segments: '数据段', suppressed: '已抑制事件', latest: '最近事件', none: '无',
    history: '打开历史', clear: '删除历史', clearScope: '删除时段', confirmTitle: '删除电脑历史？',
    confirmHelp: '删除所选时段内的事件及与之重叠的摘要。此操作无法撤销。',
    cancel: '取消', confirm: '删除', deleted: '已删除历史。', saved: '已保存。', refresh: '刷新状态',
    loading: '正在读取状态…', statusReadFailed: '无法读取电脑历史状态。', actionFailed: '无法确认此次更改。', local: '这台 Mac',
    states: { unsupported: '不支持', unavailable: '不可用', needs_permission: '需要授权', stopped: '已关闭', running: '正在记录', paused: '已暂停', error: '需要处理' },
    periods: { last_10_minutes: '最近 10 分钟', last_hour: '最近 1 小时', today: '今天', all: '全部历史' },
  },
  'zh-TW': {
    title: '電腦歷史', recordingGroup: '記錄', recording: '記錄這台 Mac 上的活動',
    recordingHelp: '在本機儲存應用程式名稱、視窗標題和互動中繼資料。關閉文字擷取後，視窗標題仍可能包含敏感資訊。',
    accessibility: '輔助使用', inputMonitoring: '輸入監控', granted: '已授權', required: '未授權',
    permissionHelp: '開始記錄需要取得兩項 macOS 權限。',
    request: '申請 macOS 權限', requestDone: '已完成權限申請。請在 macOS 中授權，再返回此處確認狀態。',
    unsupported: '活動記錄僅支援 macOS。', unavailable: '記錄輔助程式無法使用。',
    contentGroup: '內容與分析', text: '包含文字內容',
    textHelp: '在本機儲存輸入、選取的文字及輔助使用欄位內容，可能包含私訊和文件。產生摘要不需要開啟此項。',
    analysis: '允許模型產生摘要',
    analysisHelp: '將取樣後的應用程式及視窗中繼資料傳送給分析服務商，可能產生 token 費用。摘要不會傳送鍵盤文字或輔助使用欄位內容。',
    model: '分析模型', modelAuthority: '使用這台 Mac 的每日回顧分析模型。', modelMissing: '尚未設定分析模型',
    modelRequired: '請先設定分析模型，再開啟摘要。', configure: '設定', modelReadFailed: '無法讀取分析模型。',
    exclusions: '排除來源', exclusionsHelp: '僅影響後續記錄。現有事件和摘要不會刪除，保留的事件仍可參與分析。',
    protection: '已識別的安全輸入和私密瀏覽會被排除，但識別無法保證涵蓋所有情況，請主動排除敏感來源。',
    applications: '應用程式', websites: '網站', sources: '來源類型',
    recentApps: '最近使用的應用程式', recentAppsHelp: '來自保留的歷史記錄，不包含所有已安裝應用程式。',
    recentAppsFailed: '無法讀取最近使用的應用程式，請在下方填寫 Bundle ID。', selectApp: '選擇應用程式',
    applicationID: '應用程式 Bundle ID', hostname: '網站網域',
    appPlaceholder: 'com.apple.Safari', websitePlaceholder: 'example.com', websitesHelp: '包含子網域，依賴瀏覽器提供目前網址。',
    appHelp: '填寫完整 Bundle ID，區分大小寫。', add: '新增', remove: '移除', noApps: '未排除任何應用程式', noWebsites: '未排除任何網站',
    invalidApp: '請輸入應用程式 Bundle ID，例如 com.apple.Safari，最多 256 個字元。',
    invalidWebsite: '請輸入網域，不要包含協定、路徑、連接埠或萬用字元。', duplicate: '此來源已被排除。',
    tooMany: '每類最多排除 256 個來源。', iconsFailed: '無法載入應用程式名稱和圖示。',
    data: '已儲存資料', retention: '原始活動保留時間', retentionValue: '48 小時',
    retentionHelp: '過期事件會立即隱藏，並在 Maka 執行時清理。摘要獨立儲存，直至手動刪除。',
    events: '保留事件', segments: '資料區段', suppressed: '已抑制事件', latest: '最近事件', none: '無',
    history: '開啟歷史', clear: '刪除歷史', clearScope: '刪除時段', confirmTitle: '刪除電腦歷史？',
    confirmHelp: '刪除所選時段內的事件及與之重疊的摘要。此操作無法復原。',
    cancel: '取消', confirm: '刪除', deleted: '已刪除歷史。', saved: '已儲存。', refresh: '重新整理狀態',
    loading: '正在讀取狀態…', statusReadFailed: '無法讀取電腦歷史狀態。', actionFailed: '無法確認此次變更。', local: '這台 Mac',
    states: { unsupported: '不支援', unavailable: '無法使用', needs_permission: '需要授權', stopped: '已關閉', running: '正在記錄', paused: '已暫停', error: '需要處理' },
    periods: { last_10_minutes: '最近 10 分鐘', last_hour: '最近 1 小時', today: '今天', all: '全部歷史' },
  },
};

export const computerHistorySettingsCopy = (locale: UiLocale) => COPY[locale];

export function normalizeHistoryExclusion(input: string, kind: 'applications' | 'websites'): string | null {
  const value = input.trim();
  if (kind === 'applications') {
    return value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/u.test(value) ? value : null;
  }
  if (!value || /[/\\:@?#*%\s]/u.test(value)) return null;
  try {
    const hostname = new URL(`https://${value}`).hostname.replace(/^www\./u, '');
    return hostname.length <= 253 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(hostname)
      ? hostname : null;
  } catch {
    return null;
  }
}
