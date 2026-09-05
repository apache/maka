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

import type { StatusSemantic } from '@maka/ui';
import type {
  CapabilityReadinessState,
  CapabilityReasonCode,
  CapabilitySnapshot,
  OsPermissionId,
  OsPermissionState,
  RuntimeProbeState,
} from '@maka/core/capabilities';

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

type Tone = StatusSemantic;
type StatusCopy = { label: string; tone: Tone };

export type PermissionCenterCopy = {
  readiness: Record<CapabilityReadinessState, StatusCopy & { detail: string }>;
  osPermissions: Record<OsPermissionId, { label: string; purpose: string; impact: string }>;
  osStates: Record<OsPermissionState, StatusCopy>;
  loading: string;
  readFailed: string;
  noData: string;
  readAgain: string;
  actionFailed: string;
  actionFailures: Record<
    | 'invalid_id'
    | 'unsupported_platform'
    | 'unsupported_permission'
    | 'denied'
    | 'already_open'
    | 'open_settings_failed'
    | 'failed',
    string
  >;
  title: string;
  subtitle: string;
  lastRead: string;
  detectAgain: string;
  summaryAria: string;
  summaryFilterAria(label: string, count: number, selected: boolean): string;
  granted: string;
  pending: string;
  denied: string;
  other: string;
  osSection: string;
  osSectionHelp: string;
  osListAria: string;
  capabilitiesSection: string;
  capabilitiesHelp: string;
  capabilityListAria: string;
  footnote: string;
  layers: {
    aria(label: string): string;
    feature: string;
    configuration: string;
    approval: string;
    memory: string;
    runtime: string;
    featureStates: Record<CapabilitySnapshot['feature']['state'], string>;
    configurationStates: Record<CapabilitySnapshot['configuration']['state'], string>;
    approvalStates: Record<CapabilitySnapshot['actionApproval']['state'], string>;
    memoryStates: Record<CapabilitySnapshot['memoryAcceptance']['state'], string>;
    runtimeStates: Record<CapabilitySnapshot['runtimeProbe']['state'], string>;
  };
  requiredPermissions: string;
  requiredPermissionsAria(label: string): string;
  guidance: string;
  guidanceAria(label: string): string;
  auditSection: string;
  noAudit: string;
  auditAria(label: string): string;
  impact: string;
  opening: string;
  openSettings: string;
  requesting: string;
  request: string;
  /** macOS drag-to-grant onboarding (accessibility / screen recording). */
  dragGrant: string;
  dragGranting: string;
  reasons: Record<Exclude<CapabilityReasonCode, 'cu_backend_status'>, string>;
  // Single-backend assumption: CU_BACKEND_IDS is ['maka-cu'], so the backend
  // name stays a literal in copy. Revisit when a second backend lands.
  cuBackendStatus(missingPermissionLabels: readonly string[], health: RuntimeProbeState): string;
  reasonFallback: string;
};

const PERMISSION_CENTER_COPY = {
  'zh-CN': {
    readiness: {
      not_configured: { label: '等待配置', detail: '需要先打开开关或补齐配置才能启用。', tone: 'neutral' },
      denied: { label: '系统拒绝', detail: '所需系统权限被拒绝或当前平台不支持。', tone: 'error' },
      enabled: { label: '运行可用', detail: '当前快照标记为可用，具体层级见下方。', tone: 'success' },
      degraded: { label: '部分可用', detail: '已有一部分能力可用，但仍有运行态、权限或子功能需要处理。', tone: 'attention' },
      paused: { label: '已暂停', detail: '功能开关被显式关闭，但配置仍保留。', tone: 'neutral' },
    },
    osPermissions: {
      accessibility: { label: '辅助功能', purpose: 'Computer Use 需要它来读取窗口焦点 / 模拟键盘鼠标。', impact: 'Computer Use · 自动化键鼠操作' },
      screen_recording: { label: '屏幕录制', purpose: 'Computer Use 需要它来读取窗口内容；未来屏幕活动录制也会使用。', impact: 'Computer Use · 截屏上下文' },
      notifications: { label: '通知', purpose: '权限申请、回顾完成等系统通知需要它。', impact: '权限申请提醒 · 每日回顾完成通知' },
      automation: { label: '自动化（Apple Events）', purpose: 'Computer Use 控制其他 App 需要逐 target 授权。', impact: 'Computer Use · 跨 App 自动化' },
    },
    osStates: {
      unsupported: { label: '当前平台不支持', tone: 'neutral' }, unknown: { label: '无法读取状态', tone: 'neutral' },
      not_determined: { label: '等待授权', tone: 'attention' }, denied: { label: '已拒绝', tone: 'error' }, granted: { label: '已授权', tone: 'success' },
    },
    loading: '正在加载权限快照', readFailed: '无法读取权限快照', noData: '权限服务未返回数据。', readAgain: '重新读取',
    actionFailed: '权限操作失败',
    actionFailures: {
      invalid_id: '内部错误：权限 id 无法识别。',
      unsupported_platform: '当前操作系统不支持这个权限操作。',
      unsupported_permission: '当前平台没有提供这个权限的直接入口。',
      denied: '你没有授予这项权限；可以前往系统设置重新开启。',
      already_open: '另一个权限引导仍在进行，请先完成或关闭它。',
      open_settings_failed: '无法打开系统设置，请手动前往「隐私与安全性」。',
      failed: '权限操作未成功，请稍后重试。',
    },
    title: '权限与能力', subtitle: '查看 Maka 需要的系统权限和当前授权状态，直接从这里前往「系统设置 → 隐私与安全性」完成授权或撤销，不必自己翻菜单。',
    lastRead: '最近读取：', detectAgain: '重新检测', summaryAria: '按授权状态筛选系统权限', summaryFilterAria: (label, count, selected) => selected ? `${label} ${count} 项，当前筛选；再次按下显示全部` : `仅显示${label}权限，共 ${count} 项`, granted: '已授权', pending: '等待授权', denied: '已拒绝', other: '未知 / 不支持',
    osSection: '系统权限', osSectionHelp: 'Maka 读到的 OS 级权限状态。点击右侧按钮可以直接前往「系统设置 → 隐私与安全性」对应分区。', osListAria: '系统权限列表',
    capabilitiesSection: '功能能力', capabilitiesHelp: '每个能力的就绪状态由「功能开关 · 配置 · 系统权限 · 运行态探测」共同决定。',
    capabilityListAria: '功能能力列表',
    footnote: 'Maka 不会自动授予 Accessibility、Automation 或 Screen Recording。高风险自动化能力必须保持逐项审批、可审计、可撤销。这里只读取系统权限与功能能力的当前快照，授权变更仍需在「系统设置 → 隐私与安全性」完成。',
    layers: {
      aria: (label) => `${label}能力状态明细`, feature: '功能开关', configuration: '配置', approval: '操作审批', memory: '记忆写入', runtime: '运行态探测',
      featureStates: { enabled: '已开启', partial: '部分可用', disabled: '已关闭', not_available: '未开放' },
      configurationStates: { not_required: '不需要配置', missing: '等待补齐配置', present: '已填写' },
      approvalStates: { not_required: '不需要审批', required_per_action: '每次调用都需审批', required_scoped_lease: '按目标与动作类别授权', pending: '审批挂起', approved: '当前任务已批准', denied: '当前任务已拒绝' },
      memoryStates: { not_applicable: '不涉及记忆写入', disabled: '记忆写入已关闭', draft_required: '需要先草拟 memory 协议', accepted: '记忆写入已接受' },
      runtimeStates: { not_available: '尚无运行态探测', not_run: '探测未运行', healthy: '探测通过', degraded: '探测降级' },
    },
    requiredPermissions: '所需系统权限', requiredPermissionsAria: (label) => `${label}所需系统权限列表`, guidance: '处理建议', guidanceAria: (label) => `${label}处理建议列表`,
    auditSection: '审计记录', noAudit: '暂无审计记录', auditAria: (label) => `${label}审计记录列表`,
    impact: '影响功能', opening: '打开中…', openSettings: '前往系统设置', requesting: '请求中…', request: '请求授权', dragGrant: '引导授权', dragGranting: '引导中…',
    reasons: {
      disabled: '该能力当前已关闭。',
      'missing platform credentials': '未配置平台凭据',
      'macOS TCC only': '仅 macOS TCC 权限适用',
      'no Electron API for per-target Apple Events TCC status': 'Electron 暂不支持读取逐 App 的 Apple Events 授权状态',
      cu_artifact_missing: '未找到通过完整性检查的 Computer Use 执行器 artifact。',
      cu_backend_unavailable: 'Computer Use 后端当前不可用。',
      cu_executor_undistributable: '未找到通过完整性检查且可分发的 maka-cu executor。',
      cu_executor_stopped: 'maka-cu executor 已停止。',
      cu_executor_start_failed: 'maka-cu executor 启动失败或已退出。',
      cu_executor_recovering: 'maka-cu executor 正在启动或恢复。',
      cu_executor_ready: 'maka-cu executor 已就绪。',
      cu_executor_lazy_start: 'maka-cu 已可用，将在首次调用时启动。',
      activity_recorder_partial: 'Daily Review 已聚合本地任务 / 工具 / 模型活动；当前不包含屏幕与应用级录制',
      activity_recorder_probe_hint: '打开 Daily Review 可查看本地活动聚合结果',
      memory_partial: '本地 MEMORY.md 已可见；自动抽取/写入仍需用户确认',
      memory_no_probe: '透明本地记忆为文件读写能力，不做后台探测',
      accessibility_status_ambiguous: 'macOS 不区分辅助功能权限是未授权还是未申请',
      screen_recording_status_mac_only: '屏幕录制权限状态仅能在 macOS 上读取',
      notifications_status_unreadable_macos: 'Electron 无法可靠读取 macOS 通知授权状态，请在系统设置中确认',
      notifications_status_unreadable: 'Electron 无法可靠读取当前系统的通知授权状态',
      notifications_unsupported: 'Electron 通知能力不可用',
      permission_probe_failed: '权限探测失败',
    },
    cuBackendStatus: (missing, health) =>
      'maka-cu artifact 已通过本地完整性检查。'
      + (missing.length > 0 ? `等待${missing.join('、')}权限。` : '')
      + ({
        not_available: 'maka-cu service 启动失败、已退出或已停止。',
        degraded: 'maka-cu service 正在启动或恢复。',
        healthy: '操作与截图 service 已就绪；按目标与动作类别授权后可操作本机应用。',
        not_run: 'service 将在首次调用时启动；按目标与动作类别授权后可操作本机应用。',
      } satisfies Record<RuntimeProbeState, string>)[health],
    reasonFallback: '状态详情请查看运行日志。',
  },
  'zh-TW': {
    readiness: {
      not_configured: { label: '等待設定', detail: '需要先開啟開關或補齊設定才能啟用。', tone: 'neutral' },
      denied: { label: '系統拒絕', detail: '所需系統權限被拒絕或目前平臺不支援。', tone: 'error' },
      enabled: { label: '執行可用', detail: '目前快照標記為可用，具體層級見下方。', tone: 'success' },
      degraded: { label: '部分可用', detail: '已有一部分能力可用，但仍有執行態、權限或子功能需要處理。', tone: 'attention' },
      paused: { label: '已暫停', detail: '功能開關被顯式關閉，但設定仍保留。', tone: 'neutral' },
    },
    osPermissions: {
      accessibility: { label: '輔助功能', purpose: 'Computer Use 需要它來讀取視窗焦點 / 模擬鍵盤滑鼠。', impact: 'Computer Use · 自動化鍵鼠操作' },
      screen_recording: { label: '螢幕錄製', purpose: 'Computer Use 需要它來讀取視窗內容；未來螢幕活動錄製也會使用。', impact: 'Computer Use · 截圖上下文' },
      notifications: { label: '通知', purpose: '權限申請、回顧完成等系統通知需要它。', impact: '權限申請提醒 · 每日回顧完成通知' },
      automation: { label: '自動化（Apple Events）', purpose: 'Computer Use 控制其他 App 需要逐 target 授權。', impact: 'Computer Use · 跨 App 自動化' },
    },
    osStates: {
      unsupported: { label: '目前平臺不支援', tone: 'neutral' }, unknown: { label: '無法讀取狀態', tone: 'neutral' },
      not_determined: { label: '等待授權', tone: 'attention' }, denied: { label: '已拒絕', tone: 'error' }, granted: { label: '已授權', tone: 'success' },
    },
    loading: '正在載入權限快照', readFailed: '無法讀取權限快照', noData: '權限服務未返回資料。', readAgain: '重新讀取',
    actionFailed: '權限操作失敗',
    actionFailures: {
      invalid_id: '內部錯誤：權限 id 無法識別。',
      unsupported_platform: '目前作業系統不支援這個權限操作。',
      unsupported_permission: '目前平臺沒有提供這個權限的直串接口。',
      denied: '你沒有授予這項權限；可以前往系統設定重新開啟。',
      already_open: '另一個權限引導仍在進行，請先完成或關閉它。',
      open_settings_failed: '無法開啟系統設定，請手動前往「隱私與安全性」。',
      failed: '權限操作未成功，請稍後重試。',
    },
    title: '權限與能力', subtitle: '檢視 Maka 需要的系統權限和目前授權狀態，直接從這裡前往「系統設定 → 隱私與安全性」完成授權或撤銷，不必自己翻選單。',
    lastRead: '最近讀取：', detectAgain: '重新檢測', summaryAria: '按授權狀態篩選系統權限', summaryFilterAria: (label, count, selected) => selected ? `${label} ${count} 項，目前篩選；再次按下顯示全部` : `僅顯示${label}權限，共 ${count} 項`, granted: '已授權', pending: '等待授權', denied: '已拒絕', other: '未知 / 不支援',
    osSection: '系統權限', osSectionHelp: 'Maka 讀到的 OS 級權限狀態。點選右側按鈕可以直接前往「系統設定 → 隱私與安全性」對應分割槽。', osListAria: '系統權限列表',
    capabilitiesSection: '功能能力', capabilitiesHelp: '每個能力的就緒狀態由「功能開關 · 設定 · 系統權限 · 執行態探測」共同決定。',
    capabilityListAria: '功能能力列表',
    footnote: 'Maka 不會自動授予 Accessibility、Automation 或 Screen Recording。高風險自動化能力必須保持逐項審批、可審計、可撤銷。這裡只讀取系統權限與功能能力的目前快照，授權變更仍需在「系統設定 → 隱私與安全性」完成。',
    layers: {
      aria: (label) => `${label}能力狀態明細`, feature: '功能開關', configuration: '設定', approval: '操作審批', memory: '記憶寫入', runtime: '執行態探測',
      featureStates: { enabled: '已開啟', partial: '部分可用', disabled: '已關閉', not_available: '未開放' },
      configurationStates: { not_required: '不需要設定', missing: '等待補齊設定', present: '已填寫' },
      approvalStates: { not_required: '不需要審批', required_per_action: '每次呼叫都需審批', required_scoped_lease: '按目標與動作類別授權', pending: '審批掛起', approved: '目前任務已批准', denied: '目前任務已拒絕' },
      memoryStates: { not_applicable: '不涉及記憶寫入', disabled: '記憶寫入已關閉', draft_required: '需要先草擬 memory 協議', accepted: '記憶寫入已接受' },
      runtimeStates: { not_available: '尚無執行態探測', not_run: '探測未執行', healthy: '探測透過', degraded: '探測降級' },
    },
    requiredPermissions: '所需系統權限', requiredPermissionsAria: (label) => `${label}所需系統權限列表`, guidance: '處理建議', guidanceAria: (label) => `${label}處理建議列表`,
    auditSection: '審計記錄', noAudit: '暫無審計記錄', auditAria: (label) => `${label}審計記錄列表`,
    impact: '影響功能', opening: '開啟中…', openSettings: '前往系統設定', requesting: '請求中…', request: '請求授權', dragGrant: '引導授權', dragGranting: '引導中…',
    reasons: {
      disabled: '此能力目前已關閉。',
      'missing platform credentials': '未設定平台憑據',
      'macOS TCC only': '僅 macOS TCC 權限適用',
      'no Electron API for per-target Apple Events TCC status': 'Electron 暫不支援讀取逐 App 的 Apple Events 授權狀態',
      cu_artifact_missing: '找不到通過完整性檢查的 Computer Use 執行器 artifact。',
      cu_backend_unavailable: 'Computer Use 後端目前無法使用。',
      cu_executor_undistributable: '找不到通過完整性檢查且可分發的 maka-cu executor。',
      cu_executor_stopped: 'maka-cu executor 已停止。',
      cu_executor_start_failed: 'maka-cu executor 啟動失敗或已退出。',
      cu_executor_recovering: 'maka-cu executor 正在啟動或恢復。',
      cu_executor_ready: 'maka-cu executor 已就緒。',
      cu_executor_lazy_start: 'maka-cu 已可用，將在首次呼叫時啟動。',
      activity_recorder_partial: 'Daily Review 已彙整本機任務 / 工具 / 模型活動；目前不包含螢幕與應用程式層級錄製',
      activity_recorder_probe_hint: '開啟 Daily Review 可檢視本機活動彙整結果',
      memory_partial: '本機 MEMORY.md 已可見；自動擷取/寫入仍需使用者確認',
      memory_no_probe: '透明本機記憶為檔案讀寫能力，不做背景探測',
      accessibility_status_ambiguous: 'macOS 不區分輔助使用權限是未授權還是未申請',
      screen_recording_status_mac_only: '螢幕錄製權限狀態僅能在 macOS 上讀取',
      notifications_status_unreadable_macos: 'Electron 無法可靠讀取 macOS 通知授權狀態，請在系統設定中確認',
      notifications_status_unreadable: 'Electron 無法可靠讀取目前系統的通知授權狀態',
      notifications_unsupported: 'Electron 通知能力無法使用',
      permission_probe_failed: '權限探測失敗',
    },
    cuBackendStatus: (missing, health) =>
      'maka-cu artifact 已通過本機完整性檢查。'
      + (missing.length > 0 ? `等待${missing.join('、')}權限。` : '')
      + ({
        not_available: 'maka-cu service 啟動失敗、已退出或已停止。',
        degraded: 'maka-cu service 正在啟動或恢復。',
        healthy: '操作與截圖 service 已就緒；依目標與動作類別授權後可操作本機應用程式。',
        not_run: 'service 將在首次呼叫時啟動；依目標與動作類別授權後可操作本機應用程式。',
      } satisfies Record<RuntimeProbeState, string>)[health],
    reasonFallback: '狀態詳情請查看執行日誌。',
  },
  en: {
    readiness: {
      not_configured: { label: 'Needs setup', detail: 'Enable the feature or complete its configuration first.', tone: 'neutral' },
      denied: { label: 'Denied by system', detail: 'A required system permission was denied or is unsupported on this platform.', tone: 'error' },
      enabled: { label: 'Available', detail: 'The current snapshot is available; see the layers below for details.', tone: 'success' },
      degraded: { label: 'Partially available', detail: 'Some functionality is available, but runtime, permission, or sub-feature work remains.', tone: 'attention' },
      paused: { label: 'Paused', detail: 'The feature was explicitly disabled while its configuration remains saved.', tone: 'neutral' },
    },
    osPermissions: {
      accessibility: { label: 'Accessibility', purpose: 'Computer Use needs it to read window focus and simulate keyboard or mouse input.', impact: 'Computer Use · automated keyboard and mouse input' },
      screen_recording: { label: 'Screen Recording', purpose: 'Computer Use needs it to read window contents; future screen activity recording will use it too.', impact: 'Computer Use · screenshot context' },
      notifications: { label: 'Notifications', purpose: 'System alerts use it for permission requests and completed reviews.', impact: 'Permission alerts · Daily Review completion' },
      automation: { label: 'Automation (Apple Events)', purpose: 'Computer Use needs per-target authorization to control other apps.', impact: 'Computer Use · cross-app automation' },
    },
    osStates: {
      unsupported: { label: 'Unsupported on this platform', tone: 'neutral' }, unknown: { label: 'Status unavailable', tone: 'neutral' },
      not_determined: { label: 'Waiting for permission', tone: 'attention' }, denied: { label: 'Denied', tone: 'error' }, granted: { label: 'Granted', tone: 'success' },
    },
    loading: 'Loading permission snapshot', readFailed: 'Could not read permission snapshot', noData: 'The permission service returned no data.', readAgain: 'Read again',
    actionFailed: 'Permission action failed',
    actionFailures: {
      invalid_id: 'Internal error: the permission ID was not recognized.',
      unsupported_platform: 'This operating system does not support the permission action.',
      unsupported_permission: 'This platform does not provide a direct entry point for the permission.',
      denied: 'Permission was not granted. You can enable it in System Settings.',
      already_open: 'Another permission guide is still open. Finish or close it first.',
      open_settings_failed: 'Could not open System Settings. Open Privacy & Security manually.',
      failed: 'The permission action did not succeed. Try again later.',
    },
    title: 'Permissions and capabilities', subtitle: 'Review the system permissions Maka needs and their current state. Open the matching Privacy & Security section directly to grant or revoke access.',
    lastRead: 'Last read: ', detectAgain: 'Check again', summaryAria: 'Filter system permissions by authorization status', summaryFilterAria: (label, count, selected) => selected ? `${label}, ${count}; filter selected. Press again to show all permissions` : `Show only ${label.toLowerCase()} permissions, ${count}`, granted: 'Granted', pending: 'Waiting', denied: 'Denied', other: 'Unknown / unsupported',
    osSection: 'System permissions', osSectionHelp: 'OS-level permission states reported to Maka. Use the action on the right to open the matching Privacy & Security section in System Settings.', osListAria: 'System permission list',
    capabilitiesSection: 'Feature capabilities', capabilitiesHelp: 'Each readiness state combines the feature toggle, configuration, system permissions, and runtime probe.',
    capabilityListAria: 'Feature capability list',
    footnote: 'Maka never grants Accessibility, Automation, or Screen Recording automatically. High-risk automation must remain individually approved, auditable, and revocable. This page only reads the current snapshot; permission changes still happen in System Settings under Privacy & Security.',
    layers: {
      aria: (label) => `${label} capability state details`, feature: 'Feature toggle', configuration: 'Configuration', approval: 'Action approval', memory: 'Memory writes', runtime: 'Runtime probe',
      featureStates: { enabled: 'Enabled', partial: 'Partially available', disabled: 'Disabled', not_available: 'Unavailable' },
      configurationStates: { not_required: 'No configuration needed', missing: 'Configuration required', present: 'Configured' },
      approvalStates: { not_required: 'No approval needed', required_per_action: 'Approval required for every call', required_scoped_lease: 'Authorized by target and action category', pending: 'Approval pending', approved: 'Approved for this task', denied: 'Denied for this task' },
      memoryStates: { not_applicable: 'No memory writes', disabled: 'Memory writes disabled', draft_required: 'Draft a memory protocol first', accepted: 'Memory writes accepted' },
      runtimeStates: { not_available: 'No runtime probe available', not_run: 'Probe not run', healthy: 'Probe passed', degraded: 'Probe degraded' },
    },
    requiredPermissions: 'Required system permissions', requiredPermissionsAria: (label) => `${label} required system permissions`, guidance: 'Suggested actions', guidanceAria: (label) => `${label} suggested actions`,
    auditSection: 'Audit records', noAudit: 'No audit records', auditAria: (label) => `${label} audit records`,
    impact: 'Affects', opening: 'Opening…', openSettings: 'Open System Settings', requesting: 'Requesting…', request: 'Request permission', dragGrant: 'Guide me', dragGranting: 'Opening…',
    reasons: {
      disabled: 'This capability is turned off.',
      'missing platform credentials': 'Platform credentials are not configured',
      'macOS TCC only': 'Only macOS TCC permissions apply',
      'no Electron API for per-target Apple Events TCC status': 'Electron cannot read per-app Apple Events authorization status',
      cu_artifact_missing: 'No Computer Use executor artifact passed the integrity check.',
      cu_backend_unavailable: 'The Computer Use backend is currently unavailable.',
      cu_executor_undistributable: 'No distributable maka-cu executor passed the integrity check.',
      cu_executor_stopped: 'The maka-cu executor has stopped.',
      cu_executor_start_failed: 'The maka-cu executor failed to start or has exited.',
      cu_executor_recovering: 'The maka-cu executor is starting or recovering.',
      cu_executor_ready: 'The maka-cu executor is ready.',
      cu_executor_lazy_start: 'maka-cu is available and starts on first use.',
      activity_recorder_partial: 'Daily Review aggregates local task, tool, and model activity; screen and app-level recording is not included.',
      activity_recorder_probe_hint: 'Open Daily Review to see the local activity summary.',
      memory_partial: 'The local MEMORY.md is visible; automatic extraction and writes still require confirmation.',
      memory_no_probe: 'Transparent local memory is plain file access, so no background probe runs.',
      accessibility_status_ambiguous: 'macOS does not distinguish denied from never-requested Accessibility permission',
      screen_recording_status_mac_only: 'Screen Recording permission status can only be read on macOS',
      notifications_status_unreadable_macos: 'Electron cannot reliably read macOS notification authorization; check System Settings',
      notifications_status_unreadable: 'Electron cannot reliably read notification authorization on this system',
      notifications_unsupported: 'Electron notifications are unavailable',
      permission_probe_failed: 'Permission probe failed',
    },
    cuBackendStatus: (missing, health) =>
      'The maka-cu artifact passed the local integrity check. '
      + (missing.length > 0 ? `Waiting for ${missing.join(', ')} permission. ` : '')
      + ({
        not_available: 'The maka-cu service failed to start, exited, or was stopped.',
        degraded: 'The maka-cu service is starting or recovering.',
        healthy: 'The action and screenshot service is ready; grant by target and action category to operate local apps.',
        not_run: 'The service starts on first use; grant by target and action category to operate local apps.',
      } satisfies Record<RuntimeProbeState, string>)[health],
    reasonFallback: 'See the runtime logs for details.',
  },
} satisfies UiCatalog<PermissionCenterCopy>;

export function getPermissionCenterCopy(locale: UiLocale): PermissionCenterCopy {
  return PERMISSION_CENTER_COPY[locale];
}
