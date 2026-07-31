import type { SettingsSection, UiCatalog, UiLocale } from '@maka/core';
import type { SettingsNavGroup } from '../settings/nav-group-summary.js';

export type SettingsNavigationCopy = {
  groups: Record<SettingsNavGroup, string>;
  sections: Record<SettingsSection, { label: string; description: string }>;
};

const SETTINGS_NAVIGATION_COPY_BY_LOCALE = {
  zh: {
    groups: {
      general: '通用',
      'ai-integrations': 'AI 与集成',
      system: '系统',
    },
    sections: {
      general: { label: '通用', description: '隐身、启动、对话默认与网络代理等系统偏好。' },
      appearance: { label: '外观', description: '主题、配色与界面语言。' },
      models: { label: '模型', description: '模型连接、API key 与 OAuth 订阅管理。' },
      usage: { label: '使用统计', description: 'token、模型、工具使用走势与配额追踪。' },
      memory: { label: '记忆', description: '本地 MEMORY.md、项目指令文件与上下文注入开关。' },
      'daily-review': { label: '每日回顾', description: '每天分析本机对话，生成摘要、遗漏提醒和建议。' },
      voice: { label: '语音', description: '语音转写、麦克风权限与本地音频管线设置。' },
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
      general: 'General',
      'ai-integrations': 'AI & Integrations',
      system: 'System',
    },
    sections: {
      general: { label: 'General', description: 'Privacy, startup, conversation defaults, and network proxy preferences.' },
      appearance: { label: 'Appearance', description: 'Theme, color palette, and interface language.' },
      models: { label: 'Models', description: 'Model connections, API keys, and OAuth subscriptions.' },
      usage: { label: 'Usage', description: 'Token, model, tool usage trends, and quota tracking.' },
      memory: { label: 'Memory', description: 'Local MEMORY.md, project instruction files, and context injection.' },
      'daily-review': { label: 'Daily Review', description: 'Analyze local conversations for summaries, reminders, and suggestions.' },
      voice: { label: 'Voice', description: 'Transcription, microphone permissions, and the local audio pipeline.' },
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
