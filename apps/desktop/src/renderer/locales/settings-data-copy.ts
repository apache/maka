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
import type { ConfigCategory } from '@maka/storage/config-transfer';
export type DataSettingsCopy = {
  categories: Record<ConfigCategory, {
    label: string;
    detail: string;
    sensitive?: boolean;
  }>;
  importSummary: {
    connections(created: number, overwritten: number, skipped: number): string;
    settings: string;
    credentials(applied: number, skipped: number): string;
    memory: string;
    empty: string;
  };
  loadFailed: string;
  openFailed(label: string): string;
  pathCopied: string;
  copyFailed: string;
  copyFailedDetail: string;
  historyCleared: string;
  historyClearedDetail: string;
  selectCategory: string;
  exported: string;
  exportedDetail(items: readonly string[]): string;
  exportFailed: string;
  noCategories: string;
  tryAgain: string;
  imported: string;
  importFailed: string;
  invalidFile: string;
  rows: {
    workspace: string;
    workspaceDetail: string;
    loadValueFailed: string;
    loading: string;
    history: string;
    historyDetail: string;
  };
  actionsAria: string;
  opening: string;
  openWorkspace: string;
  copying: string;
  copyPath: string;
  clearing: string;
  clearHistory: string;
  backupTitle: string;
  backupNotice: string;
  pathLoadFailed(error: string): string;
  configAria: string;
  configTitle: string;
  configHelp: string;
  categoryAria: string;
  sensitiveWarning: string;
  conflictAria: string;
  skip: string;
  overwrite: string;
  exportConfig: string;
  importConfig: string;
};
const SETTINGS_DATA_COPY_BASE = {
  zh: {
    categories: {
      connections: {
        label: '模型连接',
        detail: '供应商连接与默认模型（不含密钥）'
      },
      settings: {
        label: '应用设置',
        detail: '常规、搜索、机器人、代理等设置'
      },
      memory: {
        label: '本地记忆',
        detail: '本机 MEMORY.md 的内容'
      },
      credentials: {
        label: '凭据（API 密钥、令牌）',
        detail: '模型密钥与订阅令牌等敏感信息',
        sensitive: true
      }
    },
    importSummary: {
      connections: (created, overwritten, skipped) => `连接 新增${created}·覆盖${overwritten}·跳过${skipped}`,
      settings: '设置已应用',
      credentials: (applied, skipped) => skipped > 0 ? `凭据 ${applied}（跳过 ${skipped}）` : `凭据 ${applied}`,
      memory: '记忆已应用',
      empty: '文件不含可导入的内容'
    },
    loadFailed: '载入数据目录失败',
    openFailed: label => `无法打开${label}`,
    pathCopied: '已复制工作区路径',
    copyFailed: '复制失败',
    copyFailedDetail: '剪贴板不可用或被系统拒绝。',
    historyCleared: '已清空输入历史',
    historyClearedDetail: '已发送的提示词记录已从本机移除。',
    selectCategory: '请至少选择一个类别',
    exported: '已导出配置',
    exportedDetail: items => `包含：${items.join('、')}`,
    exportFailed: '导出失败',
    noCategories: '未选择任何类别',
    tryAgain: '请稍后重试',
    imported: '已导入配置',
    importFailed: '导入失败',
    invalidFile: '文件无效或版本不受支持。',
    rows: {
      workspace: '工作区路径',
      workspaceDetail: '任务、设置、凭据和技能文件都存在这个目录下。',
      loadValueFailed: '载入失败',
      loading: '正在加载…',
      history: '输入历史',
      historyDetail: '上箭头 / 下箭头调出的已发送提示词记录，保存在本机、重启后仍在。清空后无法恢复。'
    },
    actionsAria: '工作区数据操作',
    opening: '打开中…',
    openWorkspace: '打开工作区文件夹',
    copying: '复制中…',
    copyPath: '复制路径',
    clearing: '清空中…',
    clearHistory: '清空输入历史',
    backupTitle: '备份与恢复',
    backupNotice: '本机数据保存在工作区。需要备份时先退出 Maka，再复制整个目录；恢复时替换同一路径后重启。模型连接凭据随工作区恢复后需要重新测试；订阅账号令牌通常需要重新登录。',
    pathLoadFailed: error => `无法载入工作区路径：${error}`,
    configAria: '配置导入导出',
    configTitle: '配置导入导出',
    configHelp: '勾选要导出的内容，生成一个 JSON 备份文件；换机或重装时可再导入。默认不含密钥。',
    categoryAria: '选择导出内容',
    sensitiveWarning: '⚠️ 密钥将以明文写入导出文件。任何拿到该文件的人都能使用这些密钥，请妥善保管、不要分享。',
    conflictAria: '导入时同名连接的处理方式',
    skip: '跳过',
    overwrite: '覆盖',
    exportConfig: '导出配置…',
    importConfig: '导入配置…'
  },
  en: {
    categories: {
      connections: {
        label: 'Model connections',
        detail: 'Provider connections and default models (without secrets)'
      },
      settings: {
        label: 'App settings',
        detail: 'General, search, bot, proxy, and other settings'
      },
      memory: {
        label: 'Local memory',
        detail: 'Contents of the local MEMORY.md file'
      },
      credentials: {
        label: 'Credentials (API keys and tokens)',
        detail: 'Sensitive model keys and subscription tokens',
        sensitive: true
      }
    },
    importSummary: {
      connections: (created, overwritten, skipped) => `Connections: ${created} created · ${overwritten} overwritten · ${skipped} skipped`,
      settings: 'Settings applied',
      credentials: (applied, skipped) => skipped > 0 ? `Credentials: ${applied} applied (${skipped} skipped)` : `Credentials: ${applied} applied`,
      memory: 'Memory applied',
      empty: 'The file contains no importable data'
    },
    loadFailed: 'Failed to load data directory',
    openFailed: label => `Could not open ${label}`,
    pathCopied: 'Workspace path copied',
    copyFailed: 'Copy failed',
    copyFailedDetail: 'The clipboard is unavailable or access was denied by the system.',
    historyCleared: 'Input history cleared',
    historyClearedDetail: 'Sent prompt history was removed from this device.',
    selectCategory: 'Select at least one category',
    exported: 'Configuration exported',
    exportedDetail: items => `Included: ${items.join(', ')}`,
    exportFailed: 'Export failed',
    noCategories: 'No categories selected',
    tryAgain: 'Try again later',
    imported: 'Configuration imported',
    importFailed: 'Import failed',
    invalidFile: 'The file is invalid or its version is unsupported.',
    rows: {
      workspace: 'Workspace path',
      workspaceDetail: 'Tasks, settings, credentials, and skill files are stored in this directory.',
      loadValueFailed: 'Failed to load',
      loading: 'Loading…',
      history: 'Input history',
      historyDetail: 'Previously sent prompts recalled with the Up and Down arrows are kept on this machine and persist across restarts. Clearing them cannot be undone.'
    },
    actionsAria: 'Workspace data actions',
    opening: 'Opening…',
    openWorkspace: 'Open workspace folder',
    copying: 'Copying…',
    copyPath: 'Copy path',
    clearing: 'Clearing…',
    clearHistory: 'Clear input history',
    backupTitle: 'Backup and restore',
    backupNotice: 'Local data is stored in the workspace. To back it up, quit Maka and copy the entire directory. To restore it, replace the same path and restart. Model credentials should be tested again after a restore, and subscription accounts usually need to sign in again.',
    pathLoadFailed: error => `Could not load workspace path: ${error}`,
    configAria: 'Configuration import and export',
    configTitle: 'Configuration import and export',
    configHelp: 'Select the content to export into a JSON backup. You can import it after moving devices or reinstalling. Secrets are excluded by default.',
    categoryAria: 'Select export content',
    sensitiveWarning: '⚠️ Secrets will be written to the export file as plain text. Anyone with this file can use them. Store it securely and do not share it.',
    conflictAria: 'How to handle connections with the same name during import',
    skip: 'Skip',
    overwrite: 'Overwrite',
    exportConfig: 'Export configuration…',
    importConfig: 'Import configuration…'
  }
} satisfies Omit<UiCatalog<DataSettingsCopy>, 'ko'>;
const SETTINGS_DATA_COPY = {
  ...SETTINGS_DATA_COPY_BASE,
  ko: {
    categories: {
      connections: {
        label: "모델 연결",
        detail: "공급자 연결 및 기본 모델(비밀 없음)"
      },
      settings: {
        label: "앱 설정",
        detail: "일반, 검색, 봇, 프록시 및 기타 설정"
      },
      memory: {
        label: "로컬 메모리",
        detail: "로컬 MEMORY.md 파일의 내용"
      },
      credentials: {
        label: "자격 증명(API 키 및 토큰)",
        detail: "민감한 모델 키 및 구독 토큰",
        sensitive: true
      }
    },
    importSummary: {
      connections: (created, overwritten, skipped) => `연결: ${created} 생성됨 · ${overwritten} 덮어쓰기 · ${skipped} 건너뛰기`,
      settings: "설정이 적용되었습니다.",
      credentials: (applied, skipped) => skipped > 0 ? `자격 증명: ${applied} 적용됨(${skipped} 건너뛰기)` : `자격 증명: ${applied} 적용됨`,
      memory: "메모리 적용됨",
      empty: "파일에 가져올 수 있는 데이터가 없습니다."
    },
    loadFailed: "데이터 디렉터리를 로드하지 못했습니다.",
    openFailed: label => `${label}을(를) 열 수 없습니다.`,
    pathCopied: "작업공간 경로가 복사되었습니다.",
    copyFailed: "복사 실패",
    copyFailedDetail: "클립보드를 사용할 수 없거나 시스템에서 액세스를 거부했습니다.",
    historyCleared: "입력 기록이 삭제되었습니다.",
    historyClearedDetail: "전송된 메시지 기록이 이 기기에서 삭제되었습니다.",
    selectCategory: "카테고리를 하나 이상 선택하세요.",
    exported: "내보낸 구성",
    exportedDetail: items => `포함됨: ${items.join(', ')}`,
    exportFailed: "내보내기 실패",
    noCategories: "선택한 카테고리가 없습니다.",
    tryAgain: "나중에 다시 시도해 보세요",
    imported: "가져온 구성",
    importFailed: "가져오기 실패",
    invalidFile: "파일이 잘못되었거나 해당 버전이 지원되지 않습니다.",
    rows: {
      workspace: "작업공간 경로",
      workspaceDetail: "작업, 설정, 자격 증명 및 기술 파일이 이 디렉터리에 저장됩니다.",
      loadValueFailed: "로드하지 못했습니다.",
      loading: "로드 중…",
      history: "입력 이력",
      historyDetail: "위쪽 및 아래쪽 화살표를 사용하여 호출한 이전에 전송된 프롬프트는 이 시스템에 유지되며 다시 시작해도 지속됩니다. 삭제한 후에는 취소할 수 없습니다."
    },
    actionsAria: "작업공간 데이터 작업",
    opening: "열기…",
    openWorkspace: "작업공간 폴더 열기",
    copying: "사자…",
    copyPath: "경로 복사",
    clearing: "청산…",
    clearHistory: "입력 기록 지우기",
    backupTitle: "백업 및 복원",
    backupNotice: "로컬 데이터는 작업 공간에 저장됩니다. 백업하려면 Maka를 종료하고 전체 디렉터리를 복사하세요. 복원하려면 동일한 경로를 교체하고 다시 시작하세요. 모델 자격 증명은 복원 후 다시 테스트해야 하며 일반적으로 구독 계정은 다시 로그인해야 합니다.",
    pathLoadFailed: error => `작업공간 경로를 로드할 수 없습니다: ${error}`,
    configAria: "구성 가져오기 및 내보내기",
    configTitle: "구성 가져오기 및 내보내기",
    configHelp: "JSON 백업으로 내보낼 콘텐츠를 선택하세요. 기기를 이동하거나 재설치한 후 가져올 수 있습니다. 비밀은 기본적으로 제외됩니다.",
    categoryAria: "내보내기 내용 선택",
    sensitiveWarning: "⚠️ 비밀은 내보내기 파일에 일반 텍스트로 기록됩니다. 이 파일이 있는 사람은 누구나 사용할 수 있습니다. 안전하게 보관하고 공유하지 마세요.",
    conflictAria: "가져오는 동안 동일한 이름의 연결을 처리하는 방법",
    skip: "건너뛰다",
    overwrite: "덮어쓰기",
    exportConfig: "구성 내보내기…",
    importConfig: "구성 가져오기…"
  }
} satisfies UiCatalog<DataSettingsCopy>;
export function getDataSettingsCopy(locale: UiLocale): DataSettingsCopy {
  return SETTINGS_DATA_COPY[locale];
}
