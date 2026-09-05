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
  HealthConnectionTestErrorClass,
  HealthSignal,
  HealthSignalDetail,
  HealthSignalLayer,
  HealthSignalMessageCode,
  HealthSignalSource,
  HealthSignalStatus,
} from '@maka/core/health';

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

/**
 * Health signals carry their own severity ladder — error > warning > info > ok
 * — and the colours have to stay monotonic with it. That is why `info` maps to
 * neutral rather than to attention: amber would collide with `warning` and
 * collapse five rungs into four, leaving 提示 and 警告 visually identical. Grey
 * keeps the ladder ordered (red > amber > grey > green); 提示 and 未知 share
 * grey and are told apart by their labels, which is fine because neither asks
 * for action.
 */
type HealthTone = StatusSemantic;

export type HealthCenterCopy = {
  loading: string;
  readFailed: string;
  noData: string;
  readAgain: string;
  title: string;
  subtitle: string;
  badge: string;
  lastRead: string;
  refresh: string;
  summaryAria: string;
  summaryFilterAria(label: string, count: number, selected: boolean): string;
  blockers: {
    send(count: number, totalCount: number): string;
    capability(count: number, totalCount: number): string;
  };
  layerAria(label: string): string;
  layerListAria(label: string): string;
  footnote: string;
  layers: Record<HealthSignalLayer, { label: string; description: string }>;
  statuses: Record<HealthSignalStatus, { label: string; tone: HealthTone }>;
  scopes: Record<HealthSignal['scope'], string>;
  sources: Record<HealthSignalSource, string>;
  source: string;
  blocksSend: string;
  blocksCapability: string;
  signalLabel(signal: HealthSignal): string;
  signalMessage(signal: HealthSignal): string;
  signalDetail(signal: HealthSignal): string | undefined;
};

const layersZh: HealthCenterCopy['layers'] = {
  configuration: { label: '配置', description: '是否填齐了设置页里的必填项。' },
  validation: { label: '验证', description: '凭据 / 端点的连通性测试结果，仅代表验证通过，不等于发送通路可用。' },
  permission: { label: '系统权限', description: '所需 OS / TCC 权限是否已授权。' },
  feature: { label: '功能开关', description: '功能是否被显式启用、当前是否可使用。' },
  action_approval: { label: '操作审批', description: '每次工具调用 / 高危操作的审批策略状态。' },
  memory_acceptance: { label: '记忆写入', description: '是否接受了记忆写入约定、是否启用了记忆写入。' },
  runtime_probe: { label: '运行态探测', description: '最近一次真实运行（发送 / 流式 / 接收事件）的探测结果。' },
  storage: { label: '存储', description: '工作区文件、JSONL、SQLite 等本地存储健康度。' },
};

const layersZhTw: HealthCenterCopy['layers'] = {
  configuration: { label: '設定', description: '設定頁中的必填項目是否完整。' },
  validation: { label: '驗證', description: '憑證與端點的連線測試結果；驗證通過不代表傳送路徑可用。' },
  permission: { label: '系統權限', description: '所需的 OS 與 TCC 權限是否已授權。' },
  feature: { label: '功能狀態', description: '功能是否已明確啟用，以及目前是否可用。' },
  action_approval: { label: '操作核准', description: '工具呼叫與高風險操作的核准原則狀態。' },
  memory_acceptance: { label: '記憶寫入', description: '是否已接受記憶寫入約定，以及是否已啟用寫入。' },
  runtime_probe: { label: '執行狀態探測', description: '最近一次實際傳送、串流或事件接收的探測結果。' },
  storage: { label: '儲存空間', description: '工作區檔案、JSONL、SQLite 和其他本機儲存空間的健康狀態。' },
};

const layersEn: HealthCenterCopy['layers'] = {
  configuration: { label: 'Configuration', description: 'Whether required settings are complete.' },
  validation: { label: 'Validation', description: 'Credential and endpoint connectivity results. A passing validation does not prove the send path works.' },
  permission: { label: 'System permissions', description: 'Whether required OS and TCC permissions are granted.' },
  feature: { label: 'Feature state', description: 'Whether the feature is explicitly enabled and currently available.' },
  action_approval: { label: 'Action approval', description: 'Approval policy for tool calls and high-risk actions.' },
  memory_acceptance: { label: 'Memory writes', description: 'Whether the memory-write agreement was accepted and writes are enabled.' },
  runtime_probe: { label: 'Runtime probe', description: 'The latest real send, stream, or event-receipt observation.' },
  storage: { label: 'Storage', description: 'Health of workspace files, JSONL, SQLite, and other local storage.' },
};

const SETTINGS_HEALTH_COPY = {
  'zh-CN': {
    loading: '正在加载健康快照', readFailed: '无法读取健康快照', noData: '健康服务未返回数据。', readAgain: '重新读取',
    title: '健康中心', subtitle: '各项能力当前的运行状况检查。',
    badge: '只读快照', lastRead: '最近一次读取：', refresh: '刷新', summaryAria: '按状态筛选健康信号', summaryFilterAria: (label, count, selected) => selected ? `${label} ${count} 项，当前筛选；再次按下显示全部` : `仅显示${label}健康信号，共 ${count} 项`,
    blockers: {
      send: (count, totalCount) => `全部健康信号中，${count}/${totalCount} 条会阻塞发送`,
      capability: (count, totalCount) => `全部健康信号中，${count}/${totalCount} 条会阻塞能力`,
    },
    layerAria: (label) => `${label}健康信号`, layerListAria: (label) => `${label}健康信号列表`,
    footnote: '本页不直接执行测试、修复或权限变更；它只汇总当前已记录的健康信号。需要处理问题时，请进入对应设置页或重新触发相关功能。',
    layers: layersZh,
    statuses: { ok: { label: '正常', tone: 'neutral' }, info: { label: '提示', tone: 'neutral' }, warning: { label: '警告', tone: 'attention' }, error: { label: '错误', tone: 'error' }, unknown: { label: '未知', tone: 'neutral' } },
    scopes: { llm_connection: 'LLM 连接', bot: '机器人', capability: '能力' },
    sources: { connection_test: '连接测试', capability_snapshot: '能力快照', permission_snapshot: '权限快照', runtime_probe: '运行态探测', settings: '设置' },
    source: '来源：', blocksSend: '阻塞发送', blocksCapability: '阻塞能力',
    signalLabel: (signal) => (signal.id.endsWith(':runtime') ? `${signal.label} 运行态` : signal.label),
    signalMessage: (signal) => signalMessagesZh[signal.message],
    signalDetail: (signal) => signalDetailZh(signal.detail),
  },
  'zh-TW': {
    loading: '正在載入健康快照', readFailed: '無法讀取健康快照', noData: '健康服務未返回資料。', readAgain: '重新讀取',
    title: '健康中心', subtitle: '各項能力目前的執行狀況檢查。',
    badge: '只讀快照', lastRead: '最近一次讀取：', refresh: '重新整理', summaryAria: '按狀態篩選健康訊號', summaryFilterAria: (label, count, selected) => selected ? `${label} ${count} 項，目前篩選；再次按下顯示全部` : `僅顯示${label}健康訊號，共 ${count} 項`,
    blockers: {
      send: (count, totalCount) => `全部健康訊號中，${count}/${totalCount} 條會阻塞傳送`,
      capability: (count, totalCount) => `全部健康訊號中，${count}/${totalCount} 條會阻塞能力`,
    },
    layerAria: (label) => `${label}健康訊號`, layerListAria: (label) => `${label}健康訊號列表`,
    footnote: '本頁不直接執行測試、修復或權限變更；它只彙總目前已記錄的健康訊號。需要處理問題時，請進入對應設定頁或重新觸發相關功能。',
    layers: layersZhTw,
    statuses: { ok: { label: '正常', tone: 'neutral' }, info: { label: '提示', tone: 'neutral' }, warning: { label: '警告', tone: 'attention' }, error: { label: '錯誤', tone: 'error' }, unknown: { label: '未知', tone: 'neutral' } },
    scopes: { llm_connection: 'LLM 連線', bot: '機器人', capability: '能力' },
    sources: { connection_test: '連線測試', capability_snapshot: '能力快照', permission_snapshot: '權限快照', runtime_probe: '執行態探測', settings: '設定' },
    source: '來源：', blocksSend: '阻塞傳送', blocksCapability: '阻塞能力',
    signalLabel: (signal) => (signal.id.endsWith(':runtime') ? `${signal.label} 執行狀態` : signal.label),
    signalMessage: (signal) => signalMessagesZhTw[signal.message],
    signalDetail: (signal) => signalDetailZhTw(signal.detail),
  },
  en: {
    loading: 'Loading health snapshot', readFailed: 'Could not read health snapshot', noData: 'The health service returned no data.', readAgain: 'Read again',
    title: 'Health center', subtitle: 'How each capability is currently doing.',
    badge: 'Read-only snapshot', lastRead: 'Last read: ', refresh: 'Refresh', summaryAria: 'Filter health signals by status', summaryFilterAria: (label, count, selected) => selected ? `${label}, ${count}; filter selected. Press again to show all signals` : `Show only ${label.toLowerCase()} health signals, ${count}`,
    blockers: {
      send: (count, totalCount) => `Across all health signals, ${count} of ${totalCount} ${count === 1 ? 'blocks' : 'block'} sending`,
      capability: (count, totalCount) => `Across all health signals, ${count} of ${totalCount} ${count === 1 ? 'blocks' : 'block'} capabilities`,
    },
    layerAria: (label) => `${label} health signals`, layerListAria: (label) => `${label} health signal list`,
    footnote: 'This page does not run tests, repairs, or permission changes. It only summarizes recorded health signals. Open the relevant settings page or retry the related feature to address an issue.',
    layers: layersEn,
    statuses: { ok: { label: 'Healthy', tone: 'neutral' }, info: { label: 'Info', tone: 'neutral' }, warning: { label: 'Warning', tone: 'attention' }, error: { label: 'Error', tone: 'error' }, unknown: { label: 'Unknown', tone: 'neutral' } },
    scopes: { llm_connection: 'LLM connection', bot: 'Bot', capability: 'Capability' },
    sources: { connection_test: 'Connection test', capability_snapshot: 'Capability snapshot', permission_snapshot: 'Permission snapshot', runtime_probe: 'Runtime probe', settings: 'Settings' },
    source: 'Source: ', blocksSend: 'Blocks sending', blocksCapability: 'Blocks capability',
    signalLabel: (signal) => (signal.id.endsWith(':runtime') ? `${signal.label} runtime` : signal.label),
    signalMessage: (signal) => signalMessagesEn[signal.message],
    signalDetail: (signal) => signalDetailEn(signal.detail),
  },
} satisfies UiCatalog<HealthCenterCopy>;

export function getHealthCenterCopy(locale: UiLocale): HealthCenterCopy {
  return SETTINGS_HEALTH_COPY[locale];
}

const signalMessagesZh: Record<HealthSignalMessageCode, string> = {
  connection_disabled: '连接已关闭。',
  awaiting_default_model: '等待选择默认模型。',
  validation_passed: '凭据与端点验证已通过。',
  needs_reauth: '连接需要重新修复认证。',
  validation_failed: '上次连接验证失败。',
  no_models_enabled: '没有启用任何模型。',
  not_default_source: '不是工作区的默认模型来源。',
  awaiting_validation: '等待验证连接。',
  runtime_probe_pending: '等待完成发送运行态探测。',
  send_completed: '最近一次发送已完成。',
  send_aborted: '最近一次发送已由用户停止。',
  send_failed: '最近一次发送失败。',
  capability_ok: '能力门禁已满足。',
  capability_paused: '能力已关闭或暂停。',
  capability_not_configured: '等待补齐能力配置。',
  capability_denied: '能力被必要系统权限阻塞。',
  capability_degraded: '能力运行态探测处于降级状态。',
};

const signalMessagesZhTw: Record<HealthSignalMessageCode, string> = {
  connection_disabled: '連線已關閉。',
  awaiting_default_model: '等待選擇預設模型。',
  validation_passed: '憑證與端點驗證已通過。',
  needs_reauth: '連線需要重新完成驗證。',
  validation_failed: '上次連線驗證失敗。',
  no_models_enabled: '尚未啟用任何模型。',
  not_default_source: '不是工作區的預設模型來源。',
  awaiting_validation: '等待驗證連線。',
  runtime_probe_pending: '等待完成傳送執行狀態探測。',
  send_completed: '最近一次傳送已完成。',
  send_aborted: '最近一次傳送已由使用者停止。',
  send_failed: '最近一次傳送失敗。',
  capability_ok: '能力門檻已滿足。',
  capability_paused: '能力已關閉或暫停。',
  capability_not_configured: '等待完成能力設定。',
  capability_denied: '能力受到必要系統權限阻擋。',
  capability_degraded: '能力執行狀態探測目前處於降級狀態。',
};

const signalMessagesEn: Record<HealthSignalMessageCode, string> = {
  connection_disabled: 'Connection is disabled.',
  awaiting_default_model: 'Select a default model.',
  validation_passed: 'Credentials and endpoint validation passed.',
  needs_reauth: 'The connection needs authentication repair.',
  validation_failed: 'The latest connection validation failed.',
  no_models_enabled: 'No models are enabled on this connection.',
  not_default_source: 'Not the workspace default model source.',
  awaiting_validation: 'Waiting to validate the connection.',
  runtime_probe_pending: 'Waiting for a send-path runtime probe.',
  send_completed: 'The latest send completed.',
  send_aborted: 'The latest send was stopped by the user.',
  send_failed: 'The latest send failed.',
  capability_ok: 'Capability requirements are satisfied.',
  capability_paused: 'The capability is disabled or paused.',
  capability_not_configured: 'Capability configuration is incomplete.',
  capability_denied: 'The capability is blocked by a required system permission.',
  capability_degraded: 'The capability runtime probe is degraded.',
};

const connectionTestErrorMessages = {
  'zh-CN': {
    auth: '鉴权失败',
    timeout: '请求超时',
    provider_unavailable: '模型服务返回错误',
    network: '网络错误',
    unknown: '连接测试失败',
  },
  'zh-TW': {
    auth: '驗證失敗',
    timeout: '請求逾時',
    provider_unavailable: '模型服務傳回錯誤',
    network: '網路錯誤',
    unknown: '連線測試失敗',
  },
  en: {
    auth: 'Authentication failed',
    timeout: 'Request timed out',
    provider_unavailable: 'Model service returned an error',
    network: 'Network error',
    unknown: 'Connection test failed',
  },
} satisfies UiCatalog<Record<HealthConnectionTestErrorClass, string>>;

function signalDetailZh(detail: HealthSignalDetail | undefined): string | undefined {
  if (!detail) return undefined;
  switch (detail.kind) {
    case 'validation_scope_note':
      return '这是连接验证结果，不代表发送、流式输出或中断通路已经运行通过。';
    case 'no_models_enabled_hint':
      return '在 设置 · 模型 的连接详情里启用至少一个模型后才能使用该连接。';
    case 'not_default_source_hint':
      return '在任务中显式选择该连接的模型即可正常使用;新对话的默认模型在 设置 · 通用 配置。';
    case 'runtime_probe_layers_note':
      return '凭据验证与真实发送、流式输出、中断通路是两层健康信号。';
    case 'runtime_probe_result':
      return [
        `模型=${detail.modelId}`,
        `延迟=${detail.latencyMs}ms`,
        ...(detail.errorClass ? [`错误类型=${localizedRuntimeErrorClass(detail.errorClass, 'zh-CN')}`] : []),
      ].join(' · ');
    case 'capability_reason':
      // Interim: capability-snapshot still emits zh-CN prose; code it as a
      // CapabilityReasonCode to drop this sniff.
      return /[\u3400-\u9fff]/u.test(detail.reason) ? detail.reason : '状态详情请见对应设置页。';
    case 'last_test_error_class':
      return connectionTestErrorMessages['zh-CN'][detail.errorClass];
    case 'last_test_message':
      return '连接测试状态暂时无法显示，请重新测试。';
    default:
      return unhandledDetail(detail);
  }
}

function signalDetailZhTw(detail: HealthSignalDetail | undefined): string | undefined {
  if (!detail) return undefined;
  switch (detail.kind) {
    case 'validation_scope_note':
      return '這是連線驗證結果，不代表傳送、串流輸出或中斷路徑已實際執行成功。';
    case 'no_models_enabled_hint':
      return '請在「設定・模型」的連線詳細資料中啟用至少一個模型，才能使用此連線。';
    case 'not_default_source_hint':
      return '在任務中明確選擇此連線的模型即可使用；新對話的預設模型可在「設定・一般」中設定。';
    case 'runtime_probe_layers_note':
      return '憑證驗證與實際傳送、串流輸出、中斷路徑是兩層不同的健康訊號。';
    case 'runtime_probe_result':
      return [
        `模型=${detail.modelId}`,
        `延遲=${detail.latencyMs}ms`,
        ...(detail.errorClass ? [`錯誤類型=${localizedRuntimeErrorClass(detail.errorClass, 'zh-TW')}`] : []),
      ].join(' · ');
    case 'capability_reason':
      return '狀態詳細資料請參閱對應的設定頁。';
    case 'last_test_error_class':
      return connectionTestErrorMessages['zh-TW'][detail.errorClass];
    case 'last_test_message':
      return '連線測試狀態暫時無法顯示，請重新測試。';
    default:
      return unhandledDetail(detail);
  }
}

function signalDetailEn(detail: HealthSignalDetail | undefined): string | undefined {
  if (!detail) return undefined;
  switch (detail.kind) {
    case 'validation_scope_note':
      return 'This validates the connection only; it does not prove send, streaming, or interruption paths have run successfully.';
    case 'no_models_enabled_hint':
      return "Enable at least one model in this connection's detail view under Settings · Models.";
    case 'not_default_source_hint':
      return 'Models on this connection stay usable when selected explicitly in a task; the default model for new chats lives in Settings · General.';
    case 'runtime_probe_layers_note':
      return 'Credential validation and real send, streaming, and interruption paths are two separate health layers.';
    case 'runtime_probe_result':
      return [
        `Model=${detail.modelId}`,
        `Latency=${detail.latencyMs}ms`,
        ...(detail.errorClass ? [`Error type=${localizedRuntimeErrorClass(detail.errorClass, 'en')}`] : []),
      ].join(' · ');
    case 'capability_reason':
      return 'See the corresponding settings page for details.';
    case 'last_test_error_class':
      return connectionTestErrorMessages.en[detail.errorClass];
    case 'last_test_message':
      return 'The connection test status is temporarily unavailable. Test again.';
    default:
      return unhandledDetail(detail);
  }
}

const unknownRuntimeErrorClass = {
  'zh-CN': '未知错误',
  'zh-TW': '未知錯誤',
  en: 'Unknown error',
} satisfies UiCatalog<string>;

// Runtime probes carry the turn's failure class (rate_limit, context_overflow,
// …), a wider vocabulary than connection tests; unmapped classes stay visible.
function localizedRuntimeErrorClass(errorClass: string, locale: UiLocale): string {
  const messages: Readonly<Record<string, string | undefined>> = connectionTestErrorMessages[locale];
  const normalized = errorClass.toLowerCase();
  if (normalized === 'unknown') return unknownRuntimeErrorClass[locale];
  return messages[normalized] ?? errorClass;
}

function unhandledDetail(_detail: never): undefined {
  return undefined;
}
