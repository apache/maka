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
    requiredPermissions: '所需系统权限', requiredPermissionsAria: (label) => `${label}所需系统权限列表`,
    auditSection: '审计记录', noAudit: '暂无审计记录', auditAria: (label) => `${label}审计记录列表`,
    impact: '影响功能', opening: '打开中…', openSettings: '前往系统设置', requesting: '请求中…', request: '请求授权', dragGrant: '引导授权', dragGranting: '引导中…',
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
    requiredPermissions: '所需系統權限', requiredPermissionsAria: (label) => `${label}所需系統權限列表`,
    auditSection: '審計記錄', noAudit: '暫無審計記錄', auditAria: (label) => `${label}審計記錄列表`,
    impact: '影響功能', opening: '開啟中…', openSettings: '前往系統設定', requesting: '請求中…', request: '請求授權', dragGrant: '引導授權', dragGranting: '引導中…',
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
    requiredPermissions: 'Required system permissions', requiredPermissionsAria: (label) => `${label} required system permissions`,
    auditSection: 'Audit records', noAudit: 'No audit records', auditAria: (label) => `${label} audit records`,
    impact: 'Affects', opening: 'Opening…', openSettings: 'Open System Settings', requesting: 'Requesting…', request: 'Request permission', dragGrant: 'Guide me', dragGranting: 'Opening…',
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
  ko: {
    readiness: {
      not_configured: { label: '설정 필요', detail: '먼저 기능을 켜거나 구성을 완료하세요.', tone: 'neutral' },
      denied: { label: '시스템에서 거부됨', detail: '필요한 시스템 권한이 거부되었거나 이 플랫폼에서 지원되지 않습니다.', tone: 'error' },
      enabled: { label: '사용 가능', detail: '현재 스냅샷은 사용 가능합니다. 자세한 내용은 아래 계층에서 확인하세요.', tone: 'success' },
      degraded: { label: '부분 사용 가능', detail: '일부 기능은 사용할 수 있지만 런타임, 권한, 하위 기능에 남은 작업이 있습니다.', tone: 'attention' },
      paused: { label: '일시 중지됨', detail: '구성은 저장된 채로 기능만 명시적으로 꺼졌습니다.', tone: 'neutral' },
    },
    osPermissions: {
      accessibility: { label: '손쉬운 사용', purpose: 'Computer Use가 창 포커스를 읽고 키보드나 마우스 입력을 시뮬레이션하려면 필요합니다.', impact: 'Computer Use · 키보드와 마우스 자동 입력' },
      screen_recording: { label: '화면 및 시스템 오디오 녹음', purpose: 'Computer Use가 창 내용을 읽으려면 필요합니다. 앞으로 화면 활동 기록에도 사용됩니다.', impact: 'Computer Use · 스크린샷 컨텍스트' },
      notifications: { label: '알림', purpose: '권한 요청, 데일리 리뷰 완료 등 시스템 알림에 필요합니다.', impact: '권한 알림 · 데일리 리뷰 완료' },
      automation: { label: '자동화(Apple Events)', purpose: 'Computer Use가 다른 앱을 제어하려면 대상별 허용이 필요합니다.', impact: 'Computer Use · 앱 간 자동화' },
    },
    osStates: {
      unsupported: { label: '이 플랫폼 미지원', tone: 'neutral' }, unknown: { label: '상태를 알 수 없음', tone: 'neutral' },
      not_determined: { label: '권한 대기 중', tone: 'attention' }, denied: { label: '거부됨', tone: 'error' }, granted: { label: '허용됨', tone: 'success' },
    },
    loading: '권한 스냅샷 불러오는 중', readFailed: '권한 스냅샷 읽기 실패', noData: '권한 서비스가 데이터를 반환하지 않았습니다.', readAgain: '다시 읽기',
    actionFailed: '권한 동작 실패',
    actionFailures: {
      invalid_id: '내부 오류: 권한 ID를 인식할 수 없습니다.',
      unsupported_platform: '이 운영체제는 권한 동작을 지원하지 않습니다.',
      unsupported_permission: '이 플랫폼은 해당 권한의 직접 진입점을 제공하지 않습니다.',
      denied: '권한이 허용되지 않았습니다. 시스템 설정에서 켤 수 있습니다.',
      already_open: '다른 권한 안내가 아직 열려 있습니다. 먼저 완료하거나 닫아 주세요.',
      open_settings_failed: '시스템 설정을 열지 못했습니다. 개인정보 보호 및 보안을 직접 열어 주세요.',
      failed: '권한 동작이 성공하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    },
    title: '권한과 기능 상태', subtitle: 'Maka에 필요한 시스템 권한과 현재 상태를 확인하세요. 해당하는 개인정보 보호 및 보안 섹션을 바로 열어 접근을 허용하거나 철회하세요.',
    lastRead: '최근 읽음: ', detectAgain: '다시 확인', summaryAria: '허용 상태로 시스템 권한 필터링', summaryFilterAria: (label, count, selected) => selected ? `${label}, ${count}개. 필터 적용됨. 다시 누르면 모든 권한을 표시합니다` : `${label} 권한만 표시, ${count}개`, granted: '허용됨', pending: '대기 중', denied: '거부됨', other: '알 수 없음 / 미지원',
    osSection: '시스템 권한', osSectionHelp: 'Maka가 읽은 OS 수준 권한 상태입니다. 오른쪽 동작으로 시스템 설정의 해당 개인정보 보호 및 보안 섹션을 열 수 있습니다.', osListAria: '시스템 권한 목록',
    capabilitiesSection: '기능 상태', capabilitiesHelp: '각 준비 상태는 기능 토글, 구성, 시스템 권한, 런타임 프로브를 합쳐서 결정됩니다.',
    capabilityListAria: '기능 상태 목록',
    footnote: 'Maka는 손쉬운 사용, 자동화, 화면 및 시스템 오디오 녹음을 자동으로 허용하지 않습니다. 고위험 자동화는 건별 승인, 감사 가능, 철회 가능 상태로 유지되어야 합니다. 이 페이지는 현재 스냅샷을 읽기만 합니다. 권한 변경은 여전히 시스템 설정의 개인정보 보호 및 보안에서 해야 합니다.',
    layers: {
      aria: (label) => `${label} 기능 상태 상세`, feature: '기능 토글', configuration: '구성', approval: '동작 승인', memory: '메모리 쓰기', runtime: '런타임 프로브',
      featureStates: { enabled: '켜짐', partial: '부분 사용 가능', disabled: '꺼짐', not_available: '사용할 수 없음' },
      configurationStates: { not_required: '구성 불필요', missing: '구성 필요', present: '구성됨' },
      approvalStates: { not_required: '승인 불필요', required_per_action: '호출마다 승인 필요', required_scoped_lease: '대상과 동작 범주별 허용', pending: '승인 대기 중', approved: '이 작업에 승인됨', denied: '이 작업에 거부됨' },
      memoryStates: { not_applicable: '메모리 쓰기 없음', disabled: '메모리 쓰기 꺼짐', draft_required: '메모리 프로토콜을 먼저 작성하세요', accepted: '메모리 쓰기 수락됨' },
      runtimeStates: { not_available: '런타임 프로브 없음', not_run: '프로브 미실행', healthy: '프로브 통과', degraded: '프로브 저하' },
    },
    requiredPermissions: '필요한 시스템 권한', requiredPermissionsAria: (label) => `${label} 필요 시스템 권한`,
    auditSection: '감사 기록', noAudit: '감사 기록 없음', auditAria: (label) => `${label} 감사 기록`,
    impact: '영향 범위', opening: '여는 중…', openSettings: '시스템 설정 열기', requesting: '요청하는 중…', request: '권한 요청', dragGrant: '안내 받기', dragGranting: '여는 중…',
    cuBackendStatus: (missing, health) =>
      'maka-cu 아티팩트가 로컬 무결성 검사를 통과했습니다. '
      + (missing.length > 0 ? `${missing.join(', ')} 권한을 기다리는 중입니다. ` : '')
      + ({
        not_available: 'maka-cu 서비스가 시작에 실패했거나, 종료됐거나, 중지되었습니다.',
        degraded: 'maka-cu 서비스가 시작 중이거나 복구 중입니다.',
        healthy: '동작·스크린샷 서비스가 준비됐습니다. 로컬 앱을 조작하려면 대상과 동작 범주별로 허용하세요.',
        not_run: '서비스는 처음 사용할 때 시작됩니다. 로컬 앱을 조작하려면 대상과 동작 범주별로 허용하세요.',
      } satisfies Record<RuntimeProbeState, string>)[health],
    reasonFallback: '자세한 내용은 런타임 로그를 확인하세요.',
  },
} satisfies UiCatalog<PermissionCenterCopy>;

export function getPermissionCenterCopy(locale: UiLocale): PermissionCenterCopy {
  return PERMISSION_CENTER_COPY[locale];
}
