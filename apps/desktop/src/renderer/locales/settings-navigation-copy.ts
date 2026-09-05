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
  sections: Record<SettingsSection, { label: string; description: string }>;
};

const SETTINGS_NAVIGATION_COPY_BY_LOCALE = {
  'zh-CN': {
    groups: {
      preferences: '偏好',
      capabilities: '能力',
      activity: '活动',
      system: '系统',
    },
    sections: {
      general: { label: '通用', description: '显示名称与界面语言、隐私与通知、任务默认与网络代理。' },
      appearance: { label: '外观', description: '界面主题与调色板。' },
      projects: { label: '工作区', description: '管理 Runtime Host 连接，以及默认 Host 上的项目。' },
      models: { label: '模型', description: '模型连接、API key 与 OAuth 订阅管理。' },
      subagents: { label: '子 Agent', description: '配置主 Agent 可以自动选择的子 Agent、能力边界与模型。' },
      usage: { label: '使用统计', description: 'token、模型、工具使用走势与配额追踪。' },
      'archived-tasks': { label: '已归档任务', description: '恢复或彻底删除已归档的任务。' },
      'import-tasks': { label: '导入任务', description: '把本机其他 Agent 的对话记录转换成 Maka 任务。' },
      memory: { label: '记忆', description: 'Maka 记住的内容，以及本地 MEMORY.md 文件。' },
      'daily-review': { label: '每日回顾', description: '每天分析本机任务，生成摘要、遗漏提醒和建议。' },
      'bot-chat': { label: '远程接入', description: '通过 Telegram、飞书、微信等平台从其他设备与 Maka 对话。' },
      search: { label: '联网搜索', description: '联网搜索供应商（如 Tavily）凭据与隐私边界。' },
      data: { label: '数据', description: '本地工作区路径、备份与恢复。' },
      permissions: { label: '权限与能力', description: '系统权限授予状态与 Maka 能力运行时检查。' },
      health: { label: '健康', description: '运行时连接、模型探针与本地健康状态。' },
      about: { label: '关于', description: '版本、更新与隐私承诺。' },
    },
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
      system: 'System',
    },
    sections: {
      general: { label: 'General', description: 'Display name and interface language, privacy and notifications, task defaults, and network proxy.' },
      appearance: { label: 'Appearance', description: 'Interface theme and color palette.' },
      projects: { label: 'Workspace', description: 'Manage Runtime Host connections and projects on the default Host.' },
      models: { label: 'Models', description: 'Model connections, API keys, and OAuth subscriptions.' },
      subagents: { label: 'Subagents', description: 'Configure the subagents, capability boundaries, and models the main agent may select.' },
      usage: { label: 'Usage', description: 'Token, model, tool usage trends, and quota tracking.' },
      'archived-tasks': { label: 'Archived tasks', description: 'Restore or permanently delete archived tasks.' },
      'import-tasks': { label: 'Import tasks', description: 'Convert conversations from another local agent into Maka tasks.' },
      memory: { label: 'Memory', description: 'What Maka remembers, and the local MEMORY.md file.' },
      'daily-review': { label: 'Daily Review', description: 'Analyze local tasks for summaries, reminders, and suggestions.' },
      'bot-chat': { label: 'Remote Access', description: 'Chat with Maka from other devices through Telegram, Feishu, or WeChat.' },
      search: { label: 'Web Search', description: 'Credentials and privacy boundaries for providers such as Tavily.' },
      data: { label: 'Data', description: 'Local workspace paths, backup, and restore.' },
      permissions: { label: 'Permissions & Capabilities', description: 'System grants and runtime checks for Maka capabilities.' },
      health: { label: 'Health', description: 'Runtime connections, model probes, and local health status.' },
      about: { label: 'About', description: 'Version, updates, and privacy commitments.' },
    },
  },
} satisfies UiCatalog<SettingsNavigationCopy>;

export function getSettingsNavigationCopy(locale: UiLocale): SettingsNavigationCopy {
  return SETTINGS_NAVIGATION_COPY_BY_LOCALE[locale];
}
