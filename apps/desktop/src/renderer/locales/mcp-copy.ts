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

export type McpCopy = {
  errors: {
    load: string; install(name: string): string; cancelInstall(name: string): string; save: string; import: string;
    update: string; test: string; remove: string; unavailableStatus: string; mapLine(line: number): string;
    importObject: string; importVersion(version: string): string; importServersObject: string; importProtocolVersion: string;
  };
  toast: {
    templateInstalled(name: string): string; templateInstalledDetail: string; installed(name: string): string;
    installedDetail: string; installCancelled(name: string): string; saved: string; savedDetail: string;
    imported: string; importedDetail(count: number): string; connectionOk: string; toolLatency(count: number, latencyMs: number): string;
    connectionFailed: string; removed: string;
  };
  remove: { title(id: string): string; description: string; confirm: string; cancel: string };
  page: {
    actionsAria: string; refreshing: string; refresh: string; add: string;
    metaInstalled(count: number): string; metaErrors(count: number): string;
    searchMatches(count: number): string;
    workspaceAria: string; toolbarAria: string; setupTitle: string; setupDescription: string; localStdio: string;
    categoriesAria: string; market: string; installed: string; searchPlaceholder: string; searchAria: string;
    noMarket: string; noMarketDetail(query: string): string; clearSearch: string; loading: string;
    noInstalled: string; noInstalledDetail: string; browseMarket: string; noInstalledMatch: string; noInstalledMatchDetail(query: string): string;
  };
  detail: {
    label: string; enabled: string; transport: string; endpoint: string;
    toolsLabel: string; statusLabel: string; protocolLabel: string;
    negotiatedProtocol(era: 'legacy' | 'modern', revision: string): string;
    inspectorOpened(id: string): string;
  };
  card: {
    macOnly: string; manage: string; cancellingAria(name: string): string; cancelAria(name: string): string; installAria(name: string): string;
    cancelling: string; cancel: string; install: string;
  };
  row: {
    testing: string; test: string; edit: string;
    delete: string; tools(count: number): string;
    disabled: string; disconnected: string; connecting: string; connected(count: number): string; failed: string;
  };
  editor: {
    importTitle: string; editTitle(id: string): string; addTitle: string; importSubtitle: string; manualSubtitle: string;
    modeAria: string; manual: string; pasteJson: string; jsonConfig: string; jsonHelp: string; cancel: string;
    importConnect: string; transportAria: string; localStdio: string; remoteUrl: string;
    serverId: string; command: string; commandPlaceholder: string; commandHelp: string;
    workingDirectory: string; workingDirectoryPlaceholder: string; environment: string; environmentHelp: string;
    url: string; headers: string; headersHelp: string; saveConnect: string;
    required: string; invalidUrl: string; unbalancedQuote: string;
    transportLabel: string; transportAuto: string; transportStreamableHttp: string; transportLegacySse: string;
    protocolLabel: string; protocolLegacy: string; protocolAuto: string; protocolModern: string;
    protocolHelp: string; sseProtocolHelp: string;
  };
};

const MCP_COPY = {
  zh: {
    errors: {
      load: '载入 MCP 失败', install: (name) => `安装 ${name} 失败`, cancelInstall: (name) => `取消安装 ${name} 失败`, save: '保存 MCP 失败',
      import: '导入 MCP 失败', update: '更新 MCP 失败', test: 'MCP 测试失败', remove: '删除 MCP 失败', unavailableStatus: 'Server 没有返回可用状态。',
      mapLine: (line) => `第 ${line} 行应为 KEY=value`, importObject: 'MCP JSON 必须是 object',
      importVersion: (version) => `不支持 MCP 配置版本 ${version}，当前支持 version 1 和 2`, importServersObject: 'mcpServers 必须是 object',
      importProtocolVersion: '含 protocol 的 MCP 配置必须显式使用 version 2',
    },
    toast: {
      templateInstalled: (name) => `${name} 模板已安装`, templateInstalledDetail: '请在「已安装」中完成凭据配置，再启用连接。',
      installed: (name) => `${name} 已安装`, installedDetail: '发现的工具会从下一次 agent turn 开始生效。', installCancelled: (name) => `已取消安装 ${name}`,
      saved: 'MCP 已保存', savedDetail: '新工具会从下一次 agent turn 开始生效。', imported: '已导入 MCP',
      importedDetail: (count) => `本次导入 ${count} 个 server。`, connectionOk: 'MCP 连接正常',
      toolLatency: (count, latencyMs) => `${count} 个工具 · ${latencyMs} ms`, connectionFailed: 'MCP 连接失败', removed: 'MCP 已删除',
    },
    remove: { title: (id) => `删除 MCP「${id}」？`, description: '它提供的工具会从下一次 agent turn 中移除，配置无法自动恢复。', confirm: '删除', cancel: '取消' },
    page: {
      actionsAria: 'MCP 操作', refreshing: '刷新中…', refresh: '刷新', add: '添加 MCP',
      metaInstalled: (count) => `${count} 个已安装`, metaErrors: (count) => `${count} 个连接异常`,
      searchMatches: (count) => `${count} 个匹配`,
      workspaceAria: 'MCP 市场与已安装项', toolbarAria: 'MCP 浏览操作', setupTitle: '把 Maka 连接到你的工作环境', setupDescription: '从精选模板开始，或添加任意 stdio、Streamable HTTP 与 SSE server。',
      localStdio: '本地 stdio', categoriesAria: 'MCP 分类', market: '市场', installed: '已安装',
      searchPlaceholder: '搜索 MCP…', searchAria: '搜索 MCP', noMarket: '没有找到匹配的 MCP', noMarketDetail: (query) => `换一个关键词，或清空「${query}」查看全部模板。`,
      clearSearch: '清空搜索', loading: '正在读取 MCP 配置…', noInstalled: '还没有安装 MCP', noInstalledDetail: '从市场选择模板，或手动添加你自己的 server。',
      browseMarket: '浏览市场', noInstalledMatch: '没有匹配的已安装 MCP', noInstalledMatchDetail: (query) => `换一个关键词，或清空「${query}」查看全部已安装项。`,
    },
    detail: {
      label: '服务器详情', enabled: '启用', transport: '传输方式', endpoint: '端点',
      toolsLabel: '工具', statusLabel: '状态', protocolLabel: 'MCP 协议',
      negotiatedProtocol: (era, revision) => `${era === 'modern' ? '现代' : '传统'} · ${revision}`,
      inspectorOpened: (id) => `已打开 ${id} 的详情`,
    },
    card: {
      macOnly: '仅 macOS', manage: '管理', cancellingAria: (name) => `正在取消安装 ${name}`, cancelAria: (name) => `取消安装 ${name}`, installAria: (name) => `安装 ${name}`,
      cancelling: '正在取消…', cancel: '取消安装', install: '安装',
    },
    row: {
      testing: '测试中…', test: '测试', edit: '编辑',
      delete: '删除', tools: (count) => `${count} 个工具`,
      disabled: '已停用', disconnected: '未连接', connecting: '连接中', connected: (count) => `${count} 个工具`, failed: '连接失败',
    },
    editor: {
      importTitle: '通过 JSON 导入', editTitle: (id) => `编辑 ${id}`, addTitle: '添加 MCP', importSubtitle: '粘贴 mcpServers 配置，同名 server 会被更新。',
      manualSubtitle: '配置保存在当前工作区的 mcp.json。', modeAria: 'MCP 添加方式', manual: '手动配置', pasteJson: '粘贴 JSON', jsonConfig: 'JSON 配置',
      jsonHelp: '支持完整 mcpServers 配置或直接的 server map。未在本次导入中出现的已有 MCP 会保留。', cancel: '取消', importConnect: '导入并连接',
      transportAria: '连接方式', localStdio: '本地 stdio', remoteUrl: '远程 URL',
      serverId: '服务器 ID', command: '命令',
      commandPlaceholder: 'npx -y @modelcontextprotocol/server-filesystem /path/to/folder',
      commandHelp: '完整命令行；含空格的参数用引号包裹，不经过 shell 解析。',
      workingDirectory: '工作目录', workingDirectoryPlaceholder: '可选，例如 /path/to/project',
      environment: '环境变量', environmentHelp: '每行一个 KEY=value；按 MCP 要求填写。', url: 'MCP URL', headers: 'HTTP 请求头', headersHelp: '每行一个 Header=value。',
      saveConnect: '保存并连接',
      required: '此字段为必填项。', invalidUrl: '请输入有效的 HTTP 或 HTTPS URL。', unbalancedQuote: '引号未闭合。',
      transportLabel: '传输协议', transportAuto: '自动回退', transportStreamableHttp: 'Streamable HTTP', transportLegacySse: '旧版 SSE',
      protocolLabel: '协议偏好', protocolLegacy: '传统', protocolAuto: '自动协商', protocolModern: '仅 2026-07-28',
      protocolHelp: '旧配置默认使用传统协议；自动协商会根据 server 能力选择协议。', sseProtocolHelp: '旧版 SSE 仅支持传统协议。',
    },
  },
  en: {
    errors: {
      load: 'Failed to load MCP', install: (name) => `Failed to install ${name}`, cancelInstall: (name) => `Failed to cancel installation of ${name}`, save: 'Failed to save MCP',
      import: 'Failed to import MCP', update: 'Failed to update MCP', test: 'MCP test failed', remove: 'Failed to delete MCP', unavailableStatus: 'The server did not return an available status.',
      mapLine: (line) => `Line ${line} must use KEY=value`, importObject: 'MCP JSON must be an object',
      importVersion: (version) => `Unsupported MCP config version ${version}; versions 1 and 2 are supported`, importServersObject: 'mcpServers must be an object',
      importProtocolVersion: 'MCP configurations containing protocol must explicitly use version 2',
    },
    toast: {
      templateInstalled: (name) => `${name} template installed`, templateInstalledDetail: 'Finish configuring credentials under Installed before enabling the connection.',
      installed: (name) => `${name} installed`, installedDetail: 'Discovered tools take effect from the next agent turn.', installCancelled: (name) => `Cancelled installation of ${name}`,
      saved: 'MCP saved', savedDetail: 'New tools take effect from the next agent turn.', imported: 'MCP imported', importedDetail: (count) => `Imported ${count} ${count === 1 ? 'server' : 'servers'}.`,
      connectionOk: 'MCP connection healthy', toolLatency: (count, latencyMs) => `${count} ${count === 1 ? 'tool' : 'tools'} · ${latencyMs} ms`,
      connectionFailed: 'MCP connection failed', removed: 'MCP deleted',
    },
    remove: { title: (id) => `Delete MCP “${id}”?`, description: 'Its tools will be removed from the next agent turn, and the configuration cannot be restored automatically.', confirm: 'Delete', cancel: 'Cancel' },
    page: {
      actionsAria: 'MCP actions', refreshing: 'Refreshing…', refresh: 'Refresh', add: 'Add MCP',
      metaInstalled: (count) => `${count} installed`, metaErrors: (count) => `${count} ${count === 1 ? 'connection error' : 'connection errors'}`,
      searchMatches: (count) => `${count} ${count === 1 ? 'match' : 'matches'}`,
      workspaceAria: 'MCP marketplace and installed servers', toolbarAria: 'MCP browser controls', setupTitle: 'Connect Maka to your work environment', setupDescription: 'Start with a curated template, or add any stdio, Streamable HTTP, or SSE server.',
      localStdio: 'Local stdio', categoriesAria: 'MCP categories', market: 'Marketplace', installed: 'Installed',
      searchPlaceholder: 'Search MCP…', searchAria: 'Search MCP', noMarket: 'No matching MCP servers', noMarketDetail: (query) => `Try another keyword, or clear “${query}” to view every template.`,
      clearSearch: 'Clear search', loading: 'Reading MCP configuration…', noInstalled: 'No MCP servers installed', noInstalledDetail: 'Choose a template from the marketplace, or add your own server manually.',
      browseMarket: 'Browse marketplace', noInstalledMatch: 'No matching installed MCP servers', noInstalledMatchDetail: (query) => `Try another keyword, or clear “${query}” to view every installed server.`,
    },
    detail: {
      label: 'Server details', enabled: 'Enabled', transport: 'Transport', endpoint: 'Endpoint',
      toolsLabel: 'Tools', statusLabel: 'Status', protocolLabel: 'MCP protocol',
      negotiatedProtocol: (era, revision) => `${era === 'modern' ? 'Modern' : 'Legacy'} · ${revision}`,
      inspectorOpened: (id) => `${id} details opened`,
    },
    card: {
      macOnly: 'macOS only', manage: 'Manage', cancellingAria: (name) => `Cancelling installation of ${name}`, cancelAria: (name) => `Cancel installation of ${name}`, installAria: (name) => `Install ${name}`,
      cancelling: 'Cancelling…', cancel: 'Cancel installation', install: 'Install',
    },
    row: {
      testing: 'Testing…', test: 'Test', edit: 'Edit',
      delete: 'Delete', tools: (count) => `${count} ${count === 1 ? 'tool' : 'tools'}`,
      disabled: 'Disabled', disconnected: 'Disconnected', connecting: 'Connecting', connected: (count) => `${count} ${count === 1 ? 'tool' : 'tools'}`, failed: 'Connection failed',
    },
    editor: {
      importTitle: 'Import from JSON', editTitle: (id) => `Edit ${id}`, addTitle: 'Add MCP', importSubtitle: 'Paste an mcpServers configuration; servers with matching names will be updated.',
      manualSubtitle: 'Configuration is saved in mcp.json for the current workspace.', modeAria: 'MCP add method', manual: 'Manual configuration', pasteJson: 'Paste JSON', jsonConfig: 'JSON configuration',
      jsonHelp: 'Supports a complete mcpServers configuration or a server map. Existing MCP servers omitted from this import are preserved.', cancel: 'Cancel', importConnect: 'Import and connect',
      transportAria: 'Connection method', localStdio: 'Local stdio', remoteUrl: 'Remote URL',
      serverId: 'Server ID', command: 'Command',
      commandPlaceholder: 'npx -y @modelcontextprotocol/server-filesystem /path/to/folder',
      commandHelp: 'Full command line; quote arguments containing spaces. Not interpreted by a shell.',
      workingDirectory: 'Working directory', workingDirectoryPlaceholder: 'Optional, for example /path/to/project',
      environment: 'Environment', environmentHelp: 'One KEY=value entry per line; complete the variables required by this MCP.', url: 'MCP URL', headers: 'HTTP headers', headersHelp: 'One Header=value entry per line.',
      saveConnect: 'Save and connect',
      required: 'This field is required.', invalidUrl: 'Enter a valid HTTP or HTTPS URL.', unbalancedQuote: 'Unclosed quote.',
      transportLabel: 'Transport', transportAuto: 'Auto fallback', transportStreamableHttp: 'Streamable HTTP', transportLegacySse: 'Legacy SSE',
      protocolLabel: 'Protocol preference', protocolLegacy: 'Legacy', protocolAuto: 'Auto-negotiate', protocolModern: '2026-07-28 only',
      protocolHelp: 'Existing configurations default to legacy; auto-negotiation selects an era from the server response.', sseProtocolHelp: 'Legacy SSE supports only the legacy protocol era.',
    },
  },
} satisfies UiCatalog<McpCopy>;

export function getMcpCopy(locale: UiLocale): McpCopy {
  return MCP_COPY[locale];
}
