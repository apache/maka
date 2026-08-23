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
import type { McpServerConfig } from '@maka/core/mcp';

export type McpCatalogId =
  | 'dingtalk' | 'feishu' | 'slack' | 'line' | 'notion' | 'macos-apps' | 'google-calendar'
  | 'figma' | 'vercel' | 'supabase' | 'filesystem' | 'memory' | 'playwright' | 'sequential-thinking';

export type McpCatalogEntry = {
  id: McpCatalogId;
  name: string;
  description: string;
  category: string;
  /** Text fallback glyph for entries without a library brand mark (see
      mcp-brand-marks.tsx). Branded entries render their real mark instead, so
      they omit this. */
  mark?: string;
  aliases?: string[];
  config: McpServerConfig;
  setupRequired?: boolean;
  setupLabel?: string;
  platform?: 'darwin';
};

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'dingtalk',
    name: '钉钉',
    description: '管理联系人、日历、待办与协作信息。',
    category: '沟通协作',
    aliases: ['DingTalk'],
    setupRequired: true,
    setupLabel: '需要 Client ID 与 Client Secret',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', 'dingtalk-mcp@1.1.21'],
      env: {
        DINGTALK_Client_ID: '',
        DINGTALK_Client_Secret: '',
        ACTIVE_PROFILES: 'dingtalk-contacts,dingtalk-calendar',
      },
    },
  },
  {
    id: 'feishu',
    name: '飞书',
    description: '访问飞书文档、日历、消息与 OpenAPI。',
    category: '沟通协作',
    aliases: ['Feishu', 'Lark'],
    setupRequired: true,
    setupLabel: '需要 App ID 与 App Secret',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', '@larksuiteoapi/lark-mcp@0.5.1', 'mcp'],
      env: { APP_ID: '', APP_SECRET: '' },
    },
  },
  {
    id: 'slack',
    name: 'Slack',
    description: '发送消息、管理频道并与 Slack workspace 协作。',
    category: '沟通协作',
    mark: 'S',
    setupRequired: true,
    setupLabel: '需要 Bot Token 与 Team ID',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack@2025.4.25'],
      env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '', SLACK_CHANNEL_IDS: '' },
    },
  },
  {
    id: 'line',
    name: 'LINE',
    description: '通过 LINE Bot Messaging API 发送和管理消息。',
    category: '沟通协作',
    mark: 'LINE',
    setupRequired: true,
    setupLabel: '需要 Channel Access Token',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', '@line/line-bot-mcp-server@0.5.0'],
      env: { NPM_CONFIG_IGNORE_SCRIPTS: 'true', CHANNEL_ACCESS_TOKEN: '', DESTINATION_USER_ID: '' },
    },
  },
  {
    id: 'notion',
    name: 'Notion',
    description: '搜索、读取和更新 Notion workspace。',
    category: '知识与文档',
    mark: 'N',
    setupRequired: true,
    setupLabel: '需要登录授权',
    config: { enabled: false, url: 'https://mcp.notion.com/mcp', transport: 'streamable-http', protocol: 'auto' },
  },
  {
    id: 'macos-apps',
    name: 'macOS 应用',
    description: '连接系统日历与提醒事项，并使用原生权限模型。',
    category: '系统与效率',
    aliases: ['Apple', 'Calendar', 'Reminders'],
    platform: 'darwin',
    config: { enabled: true, command: 'npx', args: ['-y', 'mcp-server-apple-events@1.4.0'] },
  },
  {
    id: 'google-calendar',
    name: 'Google 日历',
    description: '管理日程、创建会议并查询空闲时间。',
    category: '系统与效率',
    mark: '31',
    aliases: ['Google Calendar'],
    setupRequired: true,
    setupLabel: '需要 OAuth credentials 文件',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', '@cocal/google-calendar-mcp@2.6.2'],
      env: { GOOGLE_OAUTH_CREDENTIALS: '' },
    },
  },
  {
    id: 'figma',
    name: 'Figma',
    description: '读取设计文件、组件与开发交付信息。',
    category: '设计与开发',
    mark: 'F',
    setupRequired: true,
    setupLabel: '需要 Personal Access Token',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', 'figma-developer-mcp@0.13.2', '--stdio'],
      env: { FIGMA_API_KEY: '' },
    },
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: '检查项目、部署状态、日志与平台文档。',
    category: '设计与开发',
    mark: '▲',
    setupRequired: true,
    setupLabel: '需要登录授权',
    config: { enabled: false, url: 'https://mcp.vercel.com', transport: 'streamable-http', protocol: 'auto' },
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: '管理数据库、项目配置、迁移与 Edge Functions。',
    category: '设计与开发',
    mark: 'S',
    setupRequired: true,
    setupLabel: '需要登录授权',
    config: { enabled: false, url: 'https://mcp.supabase.com/mcp', transport: 'streamable-http', protocol: 'auto' },
  },
  {
    id: 'filesystem',
    name: '本地文件',
    description: '在指定目录中安全地读取、写入和管理文件。',
    category: '文件与知识',
    mark: 'FS',
    setupRequired: true,
    setupLabel: '需要选择允许访问的目录',
    config: {
      enabled: false,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/folder'],
    },
  },
  {
    id: 'memory',
    name: '持久记忆',
    description: '用结构化知识图谱记住实体、关系和重要事实。',
    category: '文件与知识',
    mark: 'M',
    config: { enabled: true, command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  },
  {
    id: 'playwright',
    name: '浏览器自动化',
    description: '让 Maka 通过 Playwright 读取和操作真实网页。',
    category: '设计与开发',
    mark: 'PW',
    config: { enabled: true, command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  },
  {
    id: 'sequential-thinking',
    name: '序列思考',
    description: '为复杂问题提供可修正、可验证的结构化推理。',
    category: '推理与规划',
    mark: 'ST',
    config: {
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
  },
];

type McpCatalogLocalizedCopy = Pick<McpCatalogEntry, 'name' | 'description' | 'category'> & {
  setupLabel: string | undefined;
};

const MCP_CATALOG_ENGLISH_COPY: Record<McpCatalogId, McpCatalogLocalizedCopy> = {
  dingtalk: { name: 'DingTalk', description: 'Manage contacts, calendars, tasks, and collaboration data.', category: 'Communication', setupLabel: 'Requires Client ID and Client Secret' },
  feishu: { name: 'Feishu', description: 'Access Feishu documents, calendars, messages, and OpenAPI.', category: 'Communication', setupLabel: 'Requires App ID and App Secret' },
  slack: { name: 'Slack', description: 'Send messages, manage channels, and collaborate in a Slack workspace.', category: 'Communication', setupLabel: 'Requires Bot Token and Team ID' },
  line: { name: 'LINE', description: 'Send and manage messages through the LINE Bot Messaging API.', category: 'Communication', setupLabel: 'Requires Channel Access Token' },
  notion: { name: 'Notion', description: 'Search, read, and update a Notion workspace.', category: 'Knowledge and documents', setupLabel: 'Requires sign-in authorization' },
  'macos-apps': { name: 'macOS apps', description: 'Connect Calendar and Reminders through native system permissions.', category: 'System and productivity', setupLabel: undefined },
  'google-calendar': { name: 'Google Calendar', description: 'Manage events, create meetings, and check availability.', category: 'System and productivity', setupLabel: 'Requires an OAuth credentials file' },
  figma: { name: 'Figma', description: 'Read design files, components, and developer handoff data.', category: 'Design and development', setupLabel: 'Requires a Personal Access Token' },
  vercel: { name: 'Vercel', description: 'Inspect projects, deployments, logs, and platform documentation.', category: 'Design and development', setupLabel: 'Requires sign-in authorization' },
  supabase: { name: 'Supabase', description: 'Manage databases, project configuration, migrations, and Edge Functions.', category: 'Design and development', setupLabel: 'Requires sign-in authorization' },
  filesystem: { name: 'Local files', description: 'Safely read, write, and manage files in selected directories.', category: 'Files and knowledge', setupLabel: 'Requires selecting allowed directories' },
  memory: { name: 'Persistent memory', description: 'Remember entities, relationships, and important facts in a structured knowledge graph.', category: 'Files and knowledge', setupLabel: undefined },
  playwright: { name: 'Browser automation', description: 'Let Maka read and operate real web pages through Playwright.', category: 'Design and development', setupLabel: undefined },
  'sequential-thinking': { name: 'Sequential thinking', description: 'Provide revisable, verifiable structured reasoning for complex problems.', category: 'Reasoning and planning', setupLabel: undefined },
};

export function getMcpCatalog(locale: UiLocale): McpCatalogEntry[] {
  if (locale === 'zh') return MCP_CATALOG;
  return MCP_CATALOG.map((entry) => ({ ...entry, ...MCP_CATALOG_ENGLISH_COPY[entry.id] }));
}

export function catalogEntryMatches(entry: McpCatalogEntry, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return [entry.id, entry.name, entry.description, entry.category, ...(entry.aliases ?? [])]
    .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}
