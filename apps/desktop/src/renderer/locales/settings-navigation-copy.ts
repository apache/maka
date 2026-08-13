import type { SettingsSection } from '@maka/core/settings';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type { SettingsNavGroup } from '../settings/nav-group-summary.js';

export type SettingsNavigationCopy = {
  groups: Record<SettingsNavGroup, string>;
  sections: Record<SettingsSection, { label: string; description: string }>;
};

const SETTINGS_NAVIGATION_COPY_BY_LOCALE = {
  zh: {
    groups: {
      preferences: '偏好',
      capabilities: '能力',
      activity: '活动',
      system: '系统',
    },
    sections: {
      general: { label: '通用', description: '显示名称与界面语言、隐私与通知、对话默认与网络代理。' },
      appearance: { label: '外观', description: '界面主题与调色板。' },
      projects: { label: '工作区', description: '选择 Runtime Host，并管理该 Host 上的项目。' },
      models: { label: '模型', description: '模型连接、API key 与 OAuth 订阅管理。' },
      subagents: { label: '子 Agent', description: '配置主 Agent 可以自动选择的子 Agent、能力边界与模型。' },
      usage: { label: '使用统计', description: 'token、模型、工具使用走势与配额追踪。' },
      memory: { label: '记忆', description: 'Maka 记住的内容，以及本地 MEMORY.md 文件。' },
      'daily-review': { label: '每日回顾', description: '每天分析本机对话，生成摘要、遗漏提醒和建议。' },
      'bot-chat': { label: '远程接入', description: '通过 Telegram、飞书、微信等平台从其他设备与 Maka 对话。' },
      search: { label: '联网搜索', description: '联网搜索供应商（如 Tavily）凭据与隐私边界。' },
      data: { label: '数据', description: '本地工作区路径、备份与恢复。' },
      permissions: { label: '权限与能力', description: '系统权限授予状态与 Maka 能力运行时检查。' },
      health: { label: '健康', description: '运行时连接、模型探针与本地健康状态。' },
      about: { label: '关于', description: '版本、运行环境与隐私承诺。' },
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
      general: { label: 'General', description: 'Display name and interface language, privacy and notifications, conversation defaults, and network proxy.' },
      appearance: { label: 'Appearance', description: 'Interface theme and color palette.' },
      projects: { label: 'Workspace', description: 'Choose the Runtime Host and manage the projects available on it.' },
      models: { label: 'Models', description: 'Model connections, API keys, and OAuth subscriptions.' },
      subagents: { label: 'Subagents', description: 'Configure the subagents, capability boundaries, and models the main agent may select.' },
      usage: { label: 'Usage', description: 'Token, model, tool usage trends, and quota tracking.' },
      memory: { label: 'Memory', description: 'What Maka remembers, and the local MEMORY.md file.' },
      'daily-review': { label: 'Daily Review', description: 'Analyze local conversations for summaries, reminders, and suggestions.' },
      'bot-chat': { label: 'Remote Access', description: 'Chat with Maka from other devices through Telegram, Feishu, or WeChat.' },
      search: { label: 'Web Search', description: 'Credentials and privacy boundaries for providers such as Tavily.' },
      data: { label: 'Data', description: 'Local workspace paths, backup, and restore.' },
      permissions: { label: 'Permissions & Capabilities', description: 'System grants and runtime checks for Maka capabilities.' },
      health: { label: 'Health', description: 'Runtime connections, model probes, and local health status.' },
      about: { label: 'About', description: 'Version, runtime environment, and privacy commitments.' },
    },
  },
} satisfies UiCatalog<SettingsNavigationCopy>;

export function getSettingsNavigationCopy(locale: UiLocale): SettingsNavigationCopy {
  return SETTINGS_NAVIGATION_COPY_BY_LOCALE[locale];
}
