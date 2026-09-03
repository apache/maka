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

import type { SettingsSection } from '@maka/core/settings';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type { SettingsNavGroup } from '../settings/nav-group-summary.js';
export type SettingsNavigationCopy = {
  groups: Record<SettingsNavGroup, string>;
  sections: Record<SettingsSection, {
    label: string;
    description: string;
  }>;
};
const SETTINGS_NAVIGATION_COPY_BY_LOCALE_BASE = {
  'zh-CN': {
    groups: {
      preferences: '偏好',
      capabilities: '能力',
      activity: '活动',
      system: '系统'
    },
    sections: {
      general: {
        label: '通用',
        description: '显示名称与界面语言、隐私与通知、任务默认与网络代理。'
      },
      appearance: {
        label: '外观',
        description: '界面主题与调色板。'
      },
      projects: {
        label: '工作区',
        description: '管理 Runtime Host 连接，以及默认 Host 上的项目。'
      },
      models: {
        label: '模型',
        description: '模型连接、API key 与 OAuth 订阅管理。'
      },
      subagents: {
        label: '子 Agent',
        description: '配置主 Agent 可以自动选择的子 Agent、能力边界与模型。'
      },
      usage: {
        label: '使用统计',
        description: 'token、模型、工具使用走势与配额追踪。'
      },
      'archived-tasks': {
        label: '已归档任务',
        description: '恢复或彻底删除已归档的任务。'
      },
      'import-tasks': {
        label: '导入任务',
        description: '把本机其他 Agent 的对话记录转换成 Maka 任务。'
      },
      memory: {
        label: '记忆',
        description: 'Maka 记住的内容，以及本地 MEMORY.md 文件。'
      },
      'daily-review': {
        label: '每日回顾',
        description: '每天分析本机任务，生成摘要、遗漏提醒和建议。'
      },
      'bot-chat': {
        label: '远程接入',
        description: '通过 Telegram、飞书、微信等平台从其他设备与 Maka 对话。'
      },
      search: {
        label: '联网搜索',
        description: '联网搜索供应商（如 Tavily）凭据与隐私边界。'
      },
      data: {
        label: '数据',
        description: '本地工作区路径、备份与恢复。'
      },
      permissions: {
        label: '权限与能力',
        description: '系统权限授予状态与 Maka 能力运行时检查。'
      },
      health: {
        label: '健康',
        description: '运行时连接、模型探针与本地健康状态。'
      },
      about: {
        label: '关于',
        description: '版本、更新与隐私承诺。'
      }
    }
  },
  'zh-TW': {
    groups: {
      preferences: '偏好',
      capabilities: '能力',
      activity: '活動',
      system: '系統',
    },
    sections: {
      general: { label: '通用', description: '顯示名稱與介面語言、隱私與通知、任務預設與網路代理。' },
      appearance: { label: '外觀', description: '介面主題與調色盤。' },
      projects: { label: '工作區', description: '管理 Runtime Host 連線，以及預設 Host 上的專案。' },
      models: { label: '模型', description: '模型連線、API key 與 OAuth 訂閱管理。' },
      subagents: { label: '子 Agent', description: '設定主 Agent 可以自動選擇的子 Agent、能力邊界與模型。' },
      usage: { label: '使用統計', description: 'token、模型、工具使用走勢與配額追蹤。' },
      'archived-tasks': { label: '已歸檔任務', description: '恢復或徹底刪除已歸檔的任務。' },
      'import-tasks': { label: '匯入任務', description: '把本機其他 Agent 的對話記錄轉換成 Maka 任務。' },
      memory: { label: '記憶', description: 'Maka 記住的內容，以及本地 MEMORY.md 檔案。' },
      'daily-review': { label: '每日回顧', description: '每天分析本機任務，生成摘要、遺漏提醒和建議。' },
      'bot-chat': { label: '遠端串接', description: '透過 Telegram、飛書、微信等平臺從其他裝置與 Maka 對話。' },
      search: { label: '聯網搜尋', description: '聯網搜尋供應商（如 Tavily）憑據與隱私邊界。' },
      data: { label: '資料', description: '本地工作區路徑、備份與恢復。' },
      permissions: { label: '權限與能力', description: '系統權限授予狀態與 Maka 能力執行時檢查。' },
      health: { label: '健康', description: '執行時連線、模型探針與本地健康狀態。' },
      about: { label: '關於', description: '版本、執行環境與隱私承諾。' },
    },
  },
  en: {
    groups: {
      preferences: 'Preferences',
      capabilities: 'Capabilities',
      activity: 'Activity',
      system: 'System'
    },
    sections: {
      general: {
        label: 'General',
        description: 'Display name and interface language, privacy and notifications, task defaults, and network proxy.'
      },
      appearance: {
        label: 'Appearance',
        description: 'Interface theme and color palette.'
      },
      projects: {
        label: 'Workspace',
        description: 'Manage Runtime Host connections and projects on the default Host.'
      },
      models: {
        label: 'Models',
        description: 'Model connections, API keys, and OAuth subscriptions.'
      },
      subagents: {
        label: 'Subagents',
        description: 'Configure the subagents, capability boundaries, and models the main agent may select.'
      },
      usage: {
        label: 'Usage',
        description: 'Token, model, tool usage trends, and quota tracking.'
      },
      'archived-tasks': {
        label: 'Archived tasks',
        description: 'Restore or permanently delete archived tasks.'
      },
      'import-tasks': {
        label: 'Import tasks',
        description: 'Convert conversations from another local agent into Maka tasks.'
      },
      memory: {
        label: 'Memory',
        description: 'What Maka remembers, and the local MEMORY.md file.'
      },
      'daily-review': {
        label: 'Daily Review',
        description: 'Analyze local tasks for summaries, reminders, and suggestions.'
      },
      'bot-chat': {
        label: 'Remote Access',
        description: 'Chat with Maka from other devices through Telegram, Feishu, or WeChat.'
      },
      search: {
        label: 'Web Search',
        description: 'Credentials and privacy boundaries for providers such as Tavily.'
      },
      data: {
        label: 'Data',
        description: 'Local workspace paths, backup, and restore.'
      },
      permissions: {
        label: 'Permissions & Capabilities',
        description: 'System grants and runtime checks for Maka capabilities.'
      },
      health: {
        label: 'Health',
        description: 'Runtime connections, model probes, and local health status.'
      },
      about: {
        label: 'About',
        description: 'Version, updates, and privacy commitments.'
      }
    }
  }
} satisfies Omit<UiCatalog<SettingsNavigationCopy>, 'ko'>;
const SETTINGS_NAVIGATION_COPY_BY_LOCALE = {
  ...SETTINGS_NAVIGATION_COPY_BY_LOCALE_BASE,
  ko: {
    groups: {
      preferences: "환경설정",
      capabilities: "기능",
      activity: "활동",
      system: "체계"
    },
    sections: {
      general: {
        label: "일반적인",
        description: "표시 이름 및 인터페이스 언어, 개인정보 보호 및 알림, 작업 기본값, 네트워크 프록시."
      },
      appearance: {
        label: "모습",
        description: "인터페이스 테마 및 색상 팔레트."
      },
      projects: {
        label: "작업공간",
        description: "기본 호스트에서 런타임 호스트 연결 및 프로젝트를 관리합니다."
      },
      models: {
        label: "모델",
        description: "모델 연결, API 키 및 OAuth 구독."
      },
      subagents: {
        label: "하위 에이전트",
        description: "기본 에이전트가 선택할 수 있는 하위 에이전트, 기능 경계 및 모델을 구성합니다."
      },
      usage: {
        label: "용법",
        description: "토큰, 모델, 도구 사용 추세 및 할당량 추적."
      },
      'archived-tasks': {
        label: "보관된 작업",
        description: "보관된 작업을 복원하거나 영구적으로 삭제합니다."
      },
      'import-tasks': {
        label: "작업 가져오기",
        description: "다른 로컬 에이전트의 대화를 Maka 작업으로 변환하세요."
      },
      memory: {
        label: "메모리",
        description: "마카가 기억하는 것과 로컬 MEMORY.md 파일."
      },
      'daily-review': {
        label: "일일 검토",
        description: "요약, 알림, 제안을 위해 로컬 작업을 분석합니다."
      },
      'bot-chat': {
        label: "원격 액세스",
        description: "Telegram, Feishu 또는 WeChat을 통해 다른 장치에서 Maka와 채팅하세요."
      },
      search: {
        label: "웹 검색",
        description: "Tavily와 같은 제공업체에 대한 자격 증명 및 개인 정보 보호 경계."
      },
      data: {
        label: "데이터",
        description: "로컬 작업공간 경로, 백업 및 복원."
      },
      permissions: {
        label: "권한 및 기능",
        description: "Maka 기능에 대한 시스템 부여 및 런타임 검사입니다."
      },
      health: {
        label: "건강",
        description: "런타임 연결, 모델 프로브 및 로컬 상태."
      },
      about: {
        label: "에 대한",
        description: "버전, 업데이트 및 개인 정보 보호 약속."
      }
    }
  }
} satisfies UiCatalog<SettingsNavigationCopy>;
export function getSettingsNavigationCopy(locale: UiLocale): SettingsNavigationCopy {
  return SETTINGS_NAVIGATION_COPY_BY_LOCALE[locale];
}
