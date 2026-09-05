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
import type { HealthSignal, HealthSignalLayer, HealthSignalSource, HealthSignalStatus } from '@maka/core/health';
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
  layers: Record<HealthSignalLayer, {
    label: string;
    description: string;
  }>;
  statuses: Record<HealthSignalStatus, {
    label: string;
    tone: HealthTone;
  }>;
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
  configuration: {
    label: '配置',
    description: '是否填齐了设置页里的必填项。'
  },
  validation: {
    label: '验证',
    description: '凭据 / 端点的连通性测试结果，仅代表验证通过，不等于发送通路可用。'
  },
  permission: {
    label: '系统权限',
    description: '所需 OS / TCC 权限是否已授权。'
  },
  feature: {
    label: '功能开关',
    description: '功能是否被显式启用、当前是否可使用。'
  },
  action_approval: {
    label: '操作审批',
    description: '每次工具调用 / 高危操作的审批策略状态。'
  },
  memory_acceptance: {
    label: '记忆写入',
    description: '是否接受了记忆写入约定、是否启用了记忆写入。'
  },
  runtime_probe: {
    label: '运行态探测',
    description: '最近一次真实运行（发送 / 流式 / 接收事件）的探测结果。'
  },
  storage: {
    label: '存储',
    description: '工作区文件、JSONL、SQLite 等本地存储健康度。'
  }
};
const layersEn: HealthCenterCopy['layers'] = {
  configuration: {
    label: 'Configuration',
    description: 'Whether required settings are complete.'
  },
  validation: {
    label: 'Validation',
    description: 'Credential and endpoint connectivity results. A passing validation does not prove the send path works.'
  },
  permission: {
    label: 'System permissions',
    description: 'Whether required OS and TCC permissions are granted.'
  },
  feature: {
    label: 'Feature state',
    description: 'Whether the feature is explicitly enabled and currently available.'
  },
  action_approval: {
    label: 'Action approval',
    description: 'Approval policy for tool calls and high-risk actions.'
  },
  memory_acceptance: {
    label: 'Memory writes',
    description: 'Whether the memory-write agreement was accepted and writes are enabled.'
  },
  runtime_probe: {
    label: 'Runtime probe',
    description: 'The latest real send, stream, or event-receipt observation.'
  },
  storage: {
    label: 'Storage',
    description: 'Health of workspace files, JSONL, SQLite, and other local storage.'
  }
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

const healthMessageZhTw: Readonly<Record<string, string>> = {
  '连接已关闭。': '連線已關閉。',
  '等待选择默认模型。': '等待選擇預設模型。',
  '凭据与端点验证已通过。': '憑證與端點驗證已通過。',
  '连接需要重新修复认证。': '連線需要重新完成驗證。',
  '上次连接验证失败。': '上次連線驗證失敗。',
  '没有启用任何模型。': '尚未啟用任何模型。',
  '不是工作区的默认模型来源。': '不是工作區的預設模型來源。',
  '等待验证连接。': '等待驗證連線。',
  '等待完成发送运行态探测。': '等待完成傳送執行狀態探測。',
  '能力门禁已满足。': '能力門檻已滿足。',
  '能力已关闭或暂停。': '能力已關閉或暫停。',
  '等待补齐能力配置。': '等待完成能力設定。',
  '能力被必要系统权限阻塞。': '能力受到必要系統權限阻擋。',
  '能力运行态探测处于降级状态。': '能力執行狀態探測目前處於降級狀態。',
  '最近一次发送已完成。': '最近一次傳送已完成。',
  '最近一次发送已由用户停止。': '最近一次傳送已由使用者停止。',
  '最近一次发送失败。': '最近一次傳送失敗。',
};

const healthDetailZhTw: Readonly<Record<string, string>> = {
  '这是连接验证结果，不代表发送、流式输出或中断通路已经运行通过。': '這是連線驗證結果，不代表傳送、串流輸出或中斷路徑已實際執行成功。',
  '在 设置 · 模型 的连接详情里启用至少一个模型后才能使用该连接。': '請在「設定・模型」的連線詳細資料中啟用至少一個模型，才能使用此連線。',
  '凭据验证与真实发送、流式输出、中断通路是两层健康信号。': '憑證驗證與實際傳送、串流輸出、中斷路徑是兩層不同的健康訊號。',
  '该能力当前已关闭。': '此能力目前已關閉。',
  '等待填写平台凭据。': '等待填寫平台憑證。',
  '仅 macOS 系统权限可探测。': '只能探測 macOS 系統權限。',
  '系统未提供可直接读取的授权状态。': '系統未提供可直接讀取的授權狀態。',
  '状态详情请见对应设置页。': '狀態詳細資料請參閱對應的設定頁。',
};

function healthSignalLabelZhTw(signal: HealthSignal): string {
  return signal.label.endsWith(' 运行态')
    ? `${signal.label.slice(0, -' 运行态'.length)} 執行狀態`
    : signal.label;
}

function healthSignalMessageZhTw(signal: HealthSignal): string {
  return healthMessageZhTw[signal.message]
    ?? (/[㐀-鿿]/u.test(signal.message) ? '健康狀態已更新。' : signal.message);
}

function healthSignalDetailZhTw(signal: HealthSignal): string | undefined {
  if (!signal.detail) return undefined;
  return healthDetailZhTw[signal.detail]
    ?? (/[㐀-鿿]/u.test(signal.detail) ? '詳細資料請參閱對應的設定頁。' : signal.detail);
}
const SETTINGS_HEALTH_COPY_BASE = {
  'zh-CN': {
    loading: '正在加载健康快照',
    readFailed: '无法读取健康快照',
    noData: '健康服务未返回数据。',
    readAgain: '重新读取',
    title: '健康中心',
    subtitle: '各项能力当前的运行状况检查。',
    badge: '只读快照',
    lastRead: '最近一次读取：',
    refresh: '刷新',
    summaryAria: '按状态筛选健康信号',
    summaryFilterAria: (label, count, selected) => selected ? `${label} ${count} 项，当前筛选；再次按下显示全部` : `仅显示${label}健康信号，共 ${count} 项`,
    blockers: {
      send: (count, totalCount) => `全部健康信号中，${count}/${totalCount} 条会阻塞发送`,
      capability: (count, totalCount) => `全部健康信号中，${count}/${totalCount} 条会阻塞能力`
    },
    layerAria: label => `${label}健康信号`,
    layerListAria: label => `${label}健康信号列表`,
    footnote: '本页不直接执行测试、修复或权限变更；它只汇总当前已记录的健康信号。需要处理问题时，请进入对应设置页或重新触发相关功能。',
    layers: layersZh,
    statuses: {
      ok: {
        label: '正常',
        tone: 'neutral'
      },
      info: {
        label: '提示',
        tone: 'neutral'
      },
      warning: {
        label: '警告',
        tone: 'attention'
      },
      error: {
        label: '错误',
        tone: 'error'
      },
      unknown: {
        label: '未知',
        tone: 'neutral'
      }
    },
    scopes: {
      app: '应用',
      llm_connection: 'LLM 连接',
      bot: '机器人',
      capability: '能力',
      storage: '存储'
    },
    sources: {
      connection_test: '连接测试',
      capability_snapshot: '能力快照',
      permission_snapshot: '权限快照',
      runtime_probe: '运行态探测',
      settings: '设置',
      storage: '本地存储'
    },
    source: '来源：',
    blocksSend: '阻塞发送',
    blocksCapability: '阻塞能力',
    signalLabel: signal => signal.label,
    signalMessage: signal => signal.message,
    signalDetail: signal => signal.detail
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
    scopes: { app: '應用', llm_connection: 'LLM 連線', bot: '機器人', capability: '能力', storage: '儲存' },
    sources: { connection_test: '連線測試', capability_snapshot: '能力快照', permission_snapshot: '權限快照', runtime_probe: '執行態探測', settings: '設定', storage: '本地儲存' },
    source: '來源：', blocksSend: '阻塞傳送', blocksCapability: '阻塞能力',
    signalLabel: healthSignalLabelZhTw,
    signalMessage: healthSignalMessageZhTw,
    signalDetail: healthSignalDetailZhTw,
  },
  en: {
    loading: 'Loading health snapshot',
    readFailed: 'Could not read health snapshot',
    noData: 'The health service returned no data.',
    readAgain: 'Read again',
    title: 'Health center',
    subtitle: 'How each capability is currently doing.',
    badge: 'Read-only snapshot',
    lastRead: 'Last read: ',
    refresh: 'Refresh',
    summaryAria: 'Filter health signals by status',
    summaryFilterAria: (label, count, selected) => selected ? `${label}, ${count}; filter selected. Press again to show all signals` : `Show only ${label.toLowerCase()} health signals, ${count}`,
    blockers: {
      send: (count, totalCount) => `Across all health signals, ${count} of ${totalCount} ${count === 1 ? 'blocks' : 'block'} sending`,
      capability: (count, totalCount) => `Across all health signals, ${count} of ${totalCount} ${count === 1 ? 'blocks' : 'block'} capabilities`
    },
    layerAria: label => `${label} health signals`,
    layerListAria: label => `${label} health signal list`,
    footnote: 'This page does not run tests, repairs, or permission changes. It only summarizes recorded health signals. Open the relevant settings page or retry the related feature to address an issue.',
    layers: layersEn,
    statuses: {
      ok: {
        label: 'Healthy',
        tone: 'neutral'
      },
      info: {
        label: 'Info',
        tone: 'neutral'
      },
      warning: {
        label: 'Warning',
        tone: 'attention'
      },
      error: {
        label: 'Error',
        tone: 'error'
      },
      unknown: {
        label: 'Unknown',
        tone: 'neutral'
      }
    },
    scopes: {
      app: 'App',
      llm_connection: 'LLM connection',
      bot: 'Bot',
      capability: 'Capability',
      storage: 'Storage'
    },
    sources: {
      connection_test: 'Connection test',
      capability_snapshot: 'Capability snapshot',
      permission_snapshot: 'Permission snapshot',
      runtime_probe: 'Runtime probe',
      settings: 'Settings',
      storage: 'Local storage'
    },
    source: 'Source: ',
    blocksSend: 'Blocks sending',
    blocksCapability: 'Blocks capability',
    signalLabel: englishSignalLabel,
    signalMessage: englishSignalMessage,
    signalDetail: englishSignalDetail
  }
} satisfies Omit<UiCatalog<HealthCenterCopy>, 'ko'>;
const SETTINGS_HEALTH_COPY = {
  ...SETTINGS_HEALTH_COPY_BASE,
  ko: {
    loading: "상태 스냅샷 로드 중",
    readFailed: "상태 스냅샷을 읽을 수 없습니다.",
    noData: "의료 서비스에서 데이터를 반환하지 않았습니다.",
    readAgain: "다시 읽어보세요",
    title: "건강 센터",
    subtitle: "각 기능이 현재 어떻게 수행되고 있는지입니다.",
    badge: "읽기 전용 스냅샷",
    lastRead: "마지막으로 읽은 날짜:",
    refresh: "새로 고치다",
    summaryAria: "상태별로 상태 신호 필터링",
    summaryFilterAria: (label, count, selected) => selected ? `${label}, ${count}; 필터가 선택되었습니다. 모든 신호를 표시하려면 다시 누르세요.` : `${label.toLowerCase()} 건강 신호, ${count}만 표시`,
    blockers: {
      send: (count, totalCount) => `전체 건강 신호 ${totalCount}개 중 ${count}개가 전송을 차단합니다.`,
      capability: (count, totalCount) => `전체 건강 신호 ${totalCount}개 중 ${count}개가 기능을 차단합니다.`
    },
    layerAria: label => `${label} 건강 신호`,
    layerListAria: label => `${label} 건강 신호 목록`,
    footnote: "이 페이지에서는 테스트, 복구 또는 권한 변경을 실행하지 않습니다. 기록된 건강 신호만 요약합니다. 관련 설정 페이지를 열거나 관련 기능을 다시 시도하여 문제를 해결하세요.",
    layers: {
      configuration: {
        label: "구성",
        description: "필수 설정이 완료되었는지 여부."
      },
      validation: {
        label: "확인",
        description: "자격 증명 및 엔드포인트 연결 결과. 유효성 검사를 통과했다고 해서 전송 경로가 작동한다는 것을 증명하는 것은 아닙니다."
      },
      permission: {
        label: "시스템 권한",
        description: "필수 OS 및 TCC 권한 부여 여부."
      },
      feature: {
        label: "기능 상태",
        description: "기능이 명시적으로 활성화되어 있고 현재 사용 가능한지 여부입니다."
      },
      action_approval: {
        label: "조치 승인",
        description: "도구 호출 및 고위험 작업에 대한 승인 정책입니다."
      },
      memory_acceptance: {
        label: "메모리 쓰기",
        description: "메모리 쓰기 계약이 승인되었고 쓰기가 활성화되었는지 여부입니다."
      },
      runtime_probe: {
        label: "런타임 프로브",
        description: "최신 실제 전송, 스트림 또는 이벤트 수신 관찰입니다."
      },
      storage: {
        label: "저장",
        description: "작업공간 파일, JSONL, SQLite 및 기타 로컬 스토리지의 상태입니다."
      }
    },
    statuses: {
      ok: {
        label: "건강한",
        tone: 'neutral'
      },
      info: {
        label: "정보",
        tone: 'neutral'
      },
      warning: {
        label: "경고",
        tone: 'attention'
      },
      error: {
        label: "오류",
        tone: 'error'
      },
      unknown: {
        label: "알려지지 않은",
        tone: 'neutral'
      }
    },
    scopes: {
      app: "앱",
      llm_connection: "LLM 연결",
      bot: "봇",
      capability: "능력",
      storage: "저장"
    },
    sources: {
      connection_test: "연결 테스트",
      capability_snapshot: "기능 스냅샷",
      permission_snapshot: "권한 스냅샷",
      runtime_probe: "런타임 프로브",
      settings: "설정",
      storage: "로컬 저장소"
    },
    source: "원천:",
    blocksSend: "전송 차단",
    blocksCapability: "블록 기능",
    signalLabel: koreanSignalLabel,
    signalMessage: koreanSignalMessage,
    signalDetail: koreanSignalDetail
  }
} satisfies UiCatalog<HealthCenterCopy>;
export function getHealthCenterCopy(locale: UiLocale): HealthCenterCopy {
  return SETTINGS_HEALTH_COPY[locale];
}
function englishSignalLabel(signal: HealthSignal): string {
  if (signal.id.endsWith(':runtime')) return `${signal.label.replace(/\s*运行态$/, '')} runtime`;
  return signal.label;
}

function koreanSignalLabel(signal: HealthSignal): string {
  const isRuntime = signal.id.endsWith(':runtime');
  const baseId = isRuntime ? signal.id.slice(0, -':runtime'.length) : signal.id;
  const capabilityLabel: Record<string, string> = {
    'capability:activity_recorder': '활동 기록',
    'capability:memory_write': '메모리',
    'capability:computer_use': '컴퓨터 사용',
  };
  const fixedLabel = capabilityLabel[baseId];
  if (fixedLabel) return isRuntime ? `${fixedLabel} 런타임` : fixedLabel;
  if (baseId.startsWith('capability:bot:')) {
    const provider = signal.label.replace(/\s+Bot(?:\s+运行态)?$/u, '');
    return isRuntime ? `${provider} 봇 런타임` : `${provider} 봇`;
  }
  if (isRuntime) return `${signal.label.replace(/\s*运行态$/u, '')} 런타임`;
  return signal.label;
}
function englishSignalMessage(signal: HealthSignal): string {
  if (signal.scope === 'llm_connection') {
    if (signal.layer === 'configuration') {
      // Three-way split matching the producer's configuration states
      // (packages/core/src/health.ts) — the message string is the anchor,
      // the same way the runtime_probe branch below parses the producer's
      // detail. Falling back on status alone described an enabled
      // non-default connection as disabled.
      if (signal.message === '不是工作区的默认模型来源。') {
        return 'Not the workspace default model source.';
      }
      if (signal.message === '没有启用任何模型。') {
        return 'No models are enabled on this connection.';
      }
      return signal.status === 'info' ? 'Connection is disabled.' : 'Select a default model.';
    }
    if (signal.layer === 'runtime_probe') {
      return {
        ok: 'The latest send completed.',
        info: 'The latest send was stopped by the user.',
        warning: 'The latest send failed.',
        error: 'The latest send failed.',
        unknown: 'Waiting for a send-path runtime probe.'
      }[signal.status];
    }
    return {
      ok: 'Credentials and endpoint validation passed.',
      info: 'Connection validation needs attention.',
      warning: 'The latest connection validation failed.',
      error: 'The connection needs authentication repair.',
      unknown: 'Waiting to validate the connection.'
    }[signal.status];
  }
  if (signal.scope === 'capability' || signal.scope === 'bot') {
    return {
      ok: 'Capability requirements are satisfied.',
      info: 'The capability is disabled or paused.',
      warning: 'Capability configuration is incomplete.',
      error: 'The capability is blocked or degraded.',
      unknown: 'Capability state is unknown.'
    }[signal.status];
  }
  return {
    ok: 'The health check passed.',
    info: 'Review this health signal.',
    warning: 'This health signal needs attention.',
    error: 'This health signal reports an error.',
    unknown: 'Health state is unknown.'
  }[signal.status];
}
function englishSignalDetail(signal: HealthSignal): string | undefined {
  if (!signal.detail) return undefined;
  if (signal.scope === 'llm_connection' && signal.layer === 'validation' && signal.status === 'ok') {
    return 'This validates the connection only; it does not prove send, streaming, or interruption paths have run successfully.';
  }
  if (signal.scope === 'llm_connection' && signal.layer === 'runtime_probe') {
    const model = signal.detail.match(/模型=([^·]+)/)?.[1]?.trim();
    const latency = signal.detail.match(/延迟=([^·]+)/)?.[1]?.trim();
    const errorClass = signal.detail.match(/错误类型=([^·]+)/)?.[1]?.trim();
    const parts = [model && `Model=${model}`, latency && `Latency=${latency}`, errorClass && `Error type=${errorClass}`].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : 'Runtime details are available in Usage settings.';
  }
  if (signal.scope === 'llm_connection' && signal.layer === 'configuration') {
    if (signal.message === '不是工作区的默认模型来源。') {
      return 'Models on this connection stay usable when selected explicitly in a task; the default model for new chats lives in Settings · General.';
    }
    if (signal.message === '没有启用任何模型。') {
      return "Enable at least one model in this connection's detail view under Settings · Models.";
    }
  }
  return 'See the corresponding settings page for details.';
}

function koreanSignalMessage(signal: HealthSignal): string {
  if (signal.scope === 'llm_connection') {
    if (signal.layer === 'configuration') {
      if (signal.message === '不是工作区的默认模型来源。') return '작업 공간의 기본 모델 소스가 아닙니다.';
      if (signal.message === '没有启用任何模型。') return '이 연결에서 활성화된 모델이 없습니다.';
      return signal.status === 'info' ? '연결이 비활성화되었습니다.' : '기본 모델을 선택하세요.';
    }
    if (signal.layer === 'runtime_probe') {
      return {
        ok: '최근 전송이 완료되었습니다.',
        info: '최근 전송이 사용자에 의해 중지되었습니다.',
        warning: '최근 전송이 실패했습니다.',
        error: '최근 전송이 실패했습니다.',
        unknown: '전송 경로 런타임 확인을 기다리는 중입니다.',
      }[signal.status];
    }
    return {
      ok: '자격 증명 및 엔드포인트 확인을 통과했습니다.',
      info: '연결 확인에 주의가 필요합니다.',
      warning: '최근 연결 확인에 실패했습니다.',
      error: '연결 인증을 복구해야 합니다.',
      unknown: '연결 확인을 기다리는 중입니다.',
    }[signal.status];
  }
  if (signal.scope === 'capability' || signal.scope === 'bot') {
    return {
      ok: '기능 요구 사항이 충족되었습니다.',
      info: '기능이 비활성화되었거나 일시 중지되었습니다.',
      warning: '기능 구성이 완료되지 않았습니다.',
      error: '기능이 차단되었거나 성능이 저하되었습니다.',
      unknown: '기능 상태를 알 수 없습니다.',
    }[signal.status];
  }
  return {
    ok: '건강 확인을 통과했습니다.',
    info: '이 건강 신호를 검토하세요.',
    warning: '이 건강 신호에 주의가 필요합니다.',
    error: '이 건강 신호에서 오류를 보고했습니다.',
    unknown: '건강 상태를 알 수 없습니다.',
  }[signal.status];
}

function koreanSignalDetail(signal: HealthSignal): string | undefined {
  if (!signal.detail) return undefined;
  if (signal.scope === 'llm_connection' && signal.layer === 'validation' && signal.status === 'ok') {
    return '연결만 확인하며 전송, 스트리밍 또는 중단 경로가 성공적으로 실행되었음을 의미하지 않습니다.';
  }
  if (signal.scope === 'llm_connection' && signal.layer === 'runtime_probe') {
    const model = signal.detail.match(/模型=([^·]+)/u)?.[1]?.trim();
    const latency = signal.detail.match(/延迟=([^·]+)/u)?.[1]?.trim();
    const errorClass = signal.detail.match(/错误类型=([^·]+)/u)?.[1]?.trim();
    const parts = [model && `모델=${model}`, latency && `지연 시간=${latency}`, errorClass && `오류 유형=${errorClass}`].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : '런타임 세부 정보는 사용량 설정에서 확인할 수 있습니다.';
  }
  if (signal.scope === 'llm_connection' && signal.layer === 'configuration') {
    if (signal.message === '不是工作区的默认模型来源。') return '이 연결의 모델은 작업에서 명시적으로 선택할 수 있습니다. 새 채팅의 기본 모델은 설정 · 일반에서 지정합니다.';
    if (signal.message === '没有启用任何模型。') return '설정 · 모델의 연결 세부 정보에서 하나 이상의 모델을 활성화하세요.';
  }
  return '자세한 내용은 해당 설정 페이지를 확인하세요.';
}
