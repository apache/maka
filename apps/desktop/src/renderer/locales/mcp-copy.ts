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
    load: string; save: string; import: string;
    update: string; test: string; remove: string; unavailableStatus: string; mapLine(line: number): string;
    importJson: string; importObject: string; importVersion(version: string): string; importServersObject: string; importProtocolVersion: string;
    writeDurabilityUnknown: string; writeOutOfSync: string;
  };
  toast: {
    saved: string; savedDetail: string;
    imported: string; importedDetail(count: number): string; connectionOk: string; toolLatency(count: number, latencyMs: number): string;
    connectionFailed: string; removed: string;
  };
  remove: { title(id: string): string; description: string; confirm: string; cancel: string };
  page: {
    actionsAria: string; refreshing: string; refresh: string; add: string;
    metaConnections(count: number): string; metaErrors(count: number): string;
    searchMatches(count: number): string;
    workspaceAria: string; toolbarAria: string; setupTitle: string; setupDescription: string; localStdio: string;
    categoriesAria: string; templates: string; connections: string; searchPlaceholder: string; searchAria: string;
    noTemplates: string; noTemplatesDetail(query: string): string; clearSearch: string; loading: string;
    noConnections: string; noConnectionsDetail: string; browseTemplates: string; noConnectionsMatch: string; noConnectionsMatchDetail(query: string): string;
  };
  detail: {
    label: string; enabled: string; transport: string; endpoint: string;
    toolsLabel: string; statusLabel: string; protocolLabel: string;
    negotiatedProtocol(era: 'legacy' | 'modern', revision: string): string;
    inspectorOpened(id: string): string;
  };
  card: { macOnly: string; useTemplate: string };
  row: {
    needsAuth: string; login: string; loginPending: string; cancelLogin: string; logout: string;
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
    idExists: string; oauth: string; oauthHelp: string; issuer: string; clientId: string; clientSecret: string; scopes: string; callbackPort: string;
    required: string; invalidUrl: string; unbalancedQuote: string;
    transportLabel: string; transportAuto: string; transportStreamableHttp: string; transportLegacySse: string;
    protocolLabel: string; protocolLegacy: string; protocolAuto: string; protocolModern: string;
    protocolHelp: string; sseProtocolHelp: string; expandAdvanced: string; collapseAdvanced: string; stdioProtocolHelp: string;
  };
};

const MCP_COPY = {
  'zh-CN': {
    errors: {
      load: '载入 MCP 失败', save: '保存 MCP 失败',
      writeDurabilityUnknown: '写入已发布，但无法确认断电后是否保留。请检查刷新后的配置再决定是否重试。',
      writeOutOfSync: '写入的持久性尚未确认，MCP 运行状态也未能与配置同步。请检查配置并重新同步后再重试。',
      import: '导入 MCP 失败', update: '更新 MCP 失败', test: 'MCP 测试失败', remove: '删除 MCP 失败', unavailableStatus: 'Server 没有返回可用状态。',
      mapLine: (line) => `第 ${line} 行应为 KEY=value`, importJson: 'MCP 配置必须是有效的 JSON', importObject: 'MCP JSON 必须是 object',
      importVersion: (version) => `不支持 MCP 配置版本 ${version}，当前支持 version 1、2 和 3`, importServersObject: 'mcpServers 必须是 object',
      importProtocolVersion: 'remote 的 protocol 需要 version 2 或 3；stdio 的 protocol 需要 version 3',
    },
    toast: {
      saved: 'MCP 已保存', savedDetail: '新工具会从下一次 agent turn 开始生效。', imported: '已导入 MCP',
      importedDetail: (count) => `本次导入 ${count} 个 server。`, connectionOk: 'MCP 连接正常',
      toolLatency: (count, latencyMs) => `${count} 个工具 · ${latencyMs} ms`, connectionFailed: 'MCP 连接失败', removed: 'MCP 已删除',
    },
    remove: { title: (id) => `删除 MCP「${id}」？`, description: '它提供的工具会从下一次 agent turn 中移除，配置无法自动恢复。', confirm: '删除', cancel: '取消' },
    page: {
      actionsAria: 'MCP 操作', refreshing: '刷新中…', refresh: '刷新', add: '添加 MCP',
      metaConnections: (count) => `${count} 个连接`, metaErrors: (count) => `${count} 个连接异常`,
      searchMatches: (count) => `${count} 个匹配`,
      workspaceAria: 'MCP 市场与连接', toolbarAria: 'MCP 浏览操作', setupTitle: '把 Maka 连接到你的工作环境', setupDescription: '从精选模板开始，或添加任意 stdio、Streamable HTTP 与 SSE server。',
      localStdio: '本地 stdio', categoriesAria: 'MCP 分类', templates: '模板', connections: '连接',
      searchPlaceholder: '搜索 MCP…', searchAria: '搜索 MCP', noTemplates: '没有找到匹配的 MCP', noTemplatesDetail: (query) => `换一个关键词，或清空「${query}」查看全部模板。`,
      clearSearch: '清空搜索', loading: '正在读取 MCP 配置…', noConnections: '还没有 MCP 连接', noConnectionsDetail: '选择模板，或手动添加你自己的 server。',
      browseTemplates: '浏览模板', noConnectionsMatch: '没有匹配的MCP 连接', noConnectionsMatchDetail: (query) => `换一个关键词，或清空「${query}」查看全部连接。`,
    },
    detail: {
      label: '服务器详情', enabled: '启用', transport: '传输方式', endpoint: '端点',
      toolsLabel: '工具', statusLabel: '状态', protocolLabel: 'MCP 协议',
      negotiatedProtocol: (era, revision) => `${era === 'modern' ? '现代' : '传统'} · ${revision}`,
      inspectorOpened: (id) => `已打开 ${id} 的详情`,
    },
    card: { macOnly: '仅 macOS', useTemplate: '使用模板' },
    row: {
      needsAuth: '需要登录', login: '登录', loginPending: '请在浏览器中完成授权', cancelLogin: '取消登录', logout: '退出授权',
      testing: '测试中…', test: '测试', edit: '编辑',
      delete: '删除', tools: (count) => `${count} 个工具`,
      disabled: '已停用', disconnected: '未连接', connecting: '连接中', connected: (count) => `${count} 个工具`, failed: '连接失败',
    },
    editor: {
      idExists: '此 ID 已存在，请使用其他名称。', oauth: 'OAuth 设置', oauthHelp: '通常自动发现。使用预注册客户端时，必须填写其所属授权服务器的 issuer。', issuer: 'OAuth issuer', clientId: '客户端 ID', clientSecret: '客户端密钥', scopes: '权限范围（空格分隔）', callbackPort: '回调端口（可选）',
      importTitle: '通过 JSON 导入', editTitle: (id) => `编辑 ${id}`, addTitle: '添加 MCP', importSubtitle: '粘贴 mcpServers 配置，同名 server 会被更新。',
      manualSubtitle: '配置保存在当前工作区的 mcp.json。', modeAria: 'MCP 添加方式', manual: '手动配置', pasteJson: '粘贴 JSON', jsonConfig: 'JSON 配置',
      jsonHelp: '支持完整 mcpServers 配置或直接的 server map。未在本次导入中出现的已有 MCP 会保留。', cancel: '取消', importConnect: '导入并连接',
      transportAria: '连接方式', localStdio: '本地 stdio', remoteUrl: '远程 URL',
      serverId: '服务器 ID', command: '命令',
      commandPlaceholder: 'npx -y @modelcontextprotocol/server-filesystem /path/to/folder',
      commandHelp: '完整命令行；含空格的参数用引号包裹，不经过 shell 解析。',
      workingDirectory: '工作目录', workingDirectoryPlaceholder: '可选，例如 /path/to/project',
      environment: '环境变量', environmentHelp: '每行一个 KEY=value；按 MCP 要求填写。', url: 'MCP URL', headers: 'HTTP 请求头', headersHelp: '每行一个 Header=value。',
      saveConnect: '保存连接',
      required: '此字段为必填项。', invalidUrl: '请输入有效的 HTTP 或 HTTPS URL。', unbalancedQuote: '引号未闭合。',
      transportLabel: '传输协议', transportAuto: '自动回退', transportStreamableHttp: 'Streamable HTTP', transportLegacySse: '旧版 SSE',
      protocolLabel: '协议偏好', protocolLegacy: '传统', protocolAuto: '自动协商', protocolModern: '仅 2026-07-28',
      protocolHelp: '旧配置默认使用传统协议；自动协商会根据 server 能力选择协议。', sseProtocolHelp: '旧版 SSE 仅支持传统协议。', expandAdvanced: '显示高级设置', collapseAdvanced: '隐藏高级设置',
      stdioProtocolHelp: '自动协商和“仅 2026-07-28”会先启动一个使用相同命令、参数、目录和环境的短期探测进程；探测结束后才启动实际连接。旧配置默认使用传统协议，只启动一个进程。',
    },
  },
  'zh-TW': {
    errors: {
      load: '載入 MCP 失敗', save: '儲存 MCP 失敗',
      writeDurabilityUnknown: '寫入已發布，但無法確認斷電後是否保留。請檢查重新整理後的設定再決定是否重試。',
      writeOutOfSync: '寫入的持久性尚未確認，MCP 執行狀態也未能與設定同步。請檢查設定並重新同步後再重試。',
      import: '匯入 MCP 失敗', update: '更新 MCP 失敗', test: 'MCP 測試失敗', remove: '刪除 MCP 失敗', unavailableStatus: 'Server 沒有返回可用狀態。',
      mapLine: (line) => `第 ${line} 行應為 KEY=value`, importJson: 'MCP 設定必須是有效的 JSON', importObject: 'MCP JSON 必須是 object',
      importVersion: (version) => `不支援 MCP 設定版本 ${version}，目前支援 version 1、2 和 3`, importServersObject: 'mcpServers 必須是 object',
      importProtocolVersion: 'remote 的 protocol 需要 version 2 或 3；stdio 的 protocol 需要 version 3',
    },
    toast: {
      saved: 'MCP 已儲存', savedDetail: '新工具會從下一次 agent turn 開始生效。', imported: '已匯入 MCP',
      importedDetail: (count) => `本次匯入 ${count} 個 server。`, connectionOk: 'MCP 連線正常',
      toolLatency: (count, latencyMs) => `${count} 個工具 · ${latencyMs} ms`, connectionFailed: 'MCP 連線失敗', removed: 'MCP 已刪除',
    },
    remove: { title: (id) => `刪除 MCP「${id}」？`, description: '它提供的工具會從下一次 agent turn 中移除，設定無法自動恢復。', confirm: '刪除', cancel: '取消' },
    page: {
      actionsAria: 'MCP 操作', refreshing: '重新整理中…', refresh: '重新整理', add: '新增 MCP',
      metaConnections: (count) => `${count} 個連線`, metaErrors: (count) => `${count} 個連線異常`,
      searchMatches: (count) => `${count} 個符合`,
      workspaceAria: 'MCP 市場與連線', toolbarAria: 'MCP 瀏覽操作', setupTitle: '把 Maka 連線到你的工作環境', setupDescription: '從精選模板開始，或新增任意 stdio、Streamable HTTP 與 SSE server。',
      localStdio: '本地 stdio', categoriesAria: 'MCP 分類', templates: '模板', connections: '連線',
      searchPlaceholder: '搜尋 MCP…', searchAria: '搜尋 MCP', noTemplates: '沒有找到符合的 MCP', noTemplatesDetail: (query) => `換一個關鍵詞，或清空「${query}」檢視全部模板。`,
      clearSearch: '清空搜尋', loading: '正在讀取 MCP 設定…', noConnections: '還沒有安裝 MCP', noConnectionsDetail: '選擇模板，或手動新增你自己的 server。',
      browseTemplates: '瀏覽模板', noConnectionsMatch: '沒有符合的MCP 連線', noConnectionsMatchDetail: (query) => `換一個關鍵詞，或清空「${query}」檢視全部連線。`,
    },
    detail: {
      label: '伺服器詳情', enabled: '啟用', transport: '傳輸方式', endpoint: '端點',
      toolsLabel: '工具', statusLabel: '狀態', protocolLabel: 'MCP 協議',
      negotiatedProtocol: (era, revision) => `${era === 'modern' ? '現代' : '傳統'} · ${revision}`,
      inspectorOpened: (id) => `已開啟 ${id} 的詳情`,
    },
    card: { macOnly: '僅 macOS', useTemplate: '使用模板' },
    row: {
      needsAuth: '需要登入', login: '登入', loginPending: '請在瀏覽器中完成授權', cancelLogin: '取消登入', logout: '登出授權',
      testing: '測試中…', test: '測試', edit: '編輯',
      delete: '刪除', tools: (count) => `${count} 個工具`,
      disabled: '已停用', disconnected: '未連線', connecting: '連線中', connected: (count) => `${count} 個工具`, failed: '連線失敗',
    },
    editor: {
      idExists: '此 ID 已存在，請使用其他名稱。', oauth: 'OAuth 設定', oauthHelp: '通常自動探索。使用預註冊用戶端時，必須填寫所屬授權伺服器的 issuer。', issuer: 'OAuth issuer', clientId: '用戶端 ID', clientSecret: '用戶端密鑰', scopes: '權限範圍（空格分隔）', callbackPort: '回呼連接埠（選填）',
      importTitle: '透過 JSON 匯入', editTitle: (id) => `編輯 ${id}`, addTitle: '新增 MCP', importSubtitle: '貼上 mcpServers 設定，同名 server 會被更新。',
      manualSubtitle: '設定儲存在目前工作區的 mcp.json。', modeAria: 'MCP 新增方式', manual: '手動設定', pasteJson: '貼上 JSON', jsonConfig: 'JSON 設定',
      jsonHelp: '支援完整 mcpServers 設定或直接的 server map。未在本次匯入中出現的已有 MCP 會保留。', cancel: '取消', importConnect: '匯入並連線',
      transportAria: '連線方式', localStdio: '本地 stdio', remoteUrl: '遠端 URL',
      serverId: '伺服器 ID', command: '命令',
      commandPlaceholder: 'npx -y @modelcontextprotocol/server-filesystem /path/to/folder',
      commandHelp: '完整命令列；含空格的引數用引號包裹，不經過 shell 解析。',
      workingDirectory: '工作目錄', workingDirectoryPlaceholder: '可選，例如 /path/to/project',
      environment: '環境變數', environmentHelp: '每行一個 KEY=value；按 MCP 要求填寫。', url: 'MCP URL', headers: 'HTTP 請求頭', headersHelp: '每行一個 Header=value。',
      saveConnect: '儲存連線',
      required: '此欄位為必填項。', invalidUrl: '請輸入有效的 HTTP 或 HTTPS URL。', unbalancedQuote: '引號未閉合。',
      transportLabel: '傳輸協議', transportAuto: '自動回退', transportStreamableHttp: 'Streamable HTTP', transportLegacySse: '舊版 SSE',
      protocolLabel: '協議偏好', protocolLegacy: '傳統', protocolAuto: '自動協商', protocolModern: '僅 2026-07-28',
      protocolHelp: '舊設定預設使用傳統協議；自動協商會根據 server 能力選擇協議。', sseProtocolHelp: '舊版 SSE 僅支援傳統協議。', expandAdvanced: '顯示進階設定', collapseAdvanced: '隱藏進階設定',
      stdioProtocolHelp: '自動協商和“僅 2026-07-28”會先啟動一個使用相同命令、引數、目錄和環境的短期探測程序；探測結束後才啟動實際連線。舊設定預設使用傳統協議，只啟動一個程序。',
    },
  },
  en: {
    errors: {
      load: 'Failed to load MCP', save: 'Failed to save MCP',
      writeDurabilityUnknown: 'The write was published, but survival after power loss could not be confirmed. Check the refreshed configuration before retrying.',
      writeOutOfSync: 'Write durability could not be confirmed, and MCP runtime state is out of sync with the configuration. Check the configuration and resynchronize before retrying.',
      import: 'Failed to import MCP', update: 'Failed to update MCP', test: 'MCP test failed', remove: 'Failed to delete MCP', unavailableStatus: 'The server did not return an available status.',
      mapLine: (line) => `Line ${line} must use KEY=value`, importJson: 'MCP configuration must be valid JSON', importObject: 'MCP JSON must be an object',
      importVersion: (version) => `Unsupported MCP config version ${version}; versions 1, 2, and 3 are supported`, importServersObject: 'mcpServers must be an object',
      importProtocolVersion: 'Remote protocol preferences require version 2 or 3; stdio protocol preferences require version 3',
    },
    toast: {
      saved: 'MCP saved', savedDetail: 'New tools take effect from the next agent turn.', imported: 'MCP imported', importedDetail: (count) => `Imported ${count} ${count === 1 ? 'server' : 'servers'}.`,
      connectionOk: 'MCP connection healthy', toolLatency: (count, latencyMs) => `${count} ${count === 1 ? 'tool' : 'tools'} · ${latencyMs} ms`,
      connectionFailed: 'MCP connection failed', removed: 'MCP deleted',
    },
    remove: { title: (id) => `Delete MCP “${id}”?`, description: 'Its tools will be removed from the next agent turn, and the configuration cannot be restored automatically.', confirm: 'Delete', cancel: 'Cancel' },
    page: {
      actionsAria: 'MCP actions', refreshing: 'Refreshing…', refresh: 'Refresh', add: 'Add MCP',
      metaConnections: (count) => `${count} connections`, metaErrors: (count) => `${count} ${count === 1 ? 'connection error' : 'connection errors'}`,
      searchMatches: (count) => `${count} ${count === 1 ? 'match' : 'matches'}`,
      workspaceAria: 'MCP marketplace and connections', toolbarAria: 'MCP browser controls', setupTitle: 'Connect Maka to your work environment', setupDescription: 'Start with a curated template, or add any stdio, Streamable HTTP, or SSE server.',
      localStdio: 'Local stdio', categoriesAria: 'MCP categories', templates: 'Templates', connections: 'Connections',
      searchPlaceholder: 'Search MCP…', searchAria: 'Search MCP', noTemplates: 'No matching MCP servers', noTemplatesDetail: (query) => `Try another keyword, or clear “${query}” to view every template.`,
      clearSearch: 'Clear search', loading: 'Reading MCP configuration…', noConnections: 'No MCP connections', noConnectionsDetail: 'Choose a template from the templates, or add your own server manually.',
      browseTemplates: 'Browse templates', noConnectionsMatch: 'No matching MCP connections', noConnectionsMatchDetail: (query) => `Try another keyword, or clear “${query}” to view every connection.`,
    },
    detail: {
      label: 'Server details', enabled: 'Enabled', transport: 'Transport', endpoint: 'Endpoint',
      toolsLabel: 'Tools', statusLabel: 'Status', protocolLabel: 'MCP protocol',
      negotiatedProtocol: (era, revision) => `${era === 'modern' ? 'Modern' : 'Legacy'} · ${revision}`,
      inspectorOpened: (id) => `${id} details opened`,
    },
    card: { macOnly: 'macOS only', useTemplate: 'Use template' },
    row: {
      needsAuth: 'Login required', login: 'Log in', loginPending: 'Complete authorization in your browser', cancelLogin: 'Cancel login', logout: 'Log out',
      testing: 'Testing…', test: 'Test', edit: 'Edit',
      delete: 'Delete', tools: (count) => `${count} ${count === 1 ? 'tool' : 'tools'}`,
      disabled: 'Disabled', disconnected: 'Disconnected', connecting: 'Connecting', connected: (count) => `${count} ${count === 1 ? 'tool' : 'tools'}`, failed: 'Connection failed',
    },
    editor: {
      idExists: 'This ID already exists. Choose another name.', oauth: 'OAuth settings', oauthHelp: 'Usually discovered automatically. Pre-registered clients must specify their authorization server issuer.', issuer: 'OAuth issuer', clientId: 'Client ID', clientSecret: 'Client secret', scopes: 'Scopes (space separated)', callbackPort: 'Callback port (optional)',
      importTitle: 'Import from JSON', editTitle: (id) => `Edit ${id}`, addTitle: 'Add MCP', importSubtitle: 'Paste an mcpServers configuration; servers with matching names will be updated.',
      manualSubtitle: 'Configuration is saved in mcp.json for the current workspace.', modeAria: 'MCP add method', manual: 'Manual configuration', pasteJson: 'Paste JSON', jsonConfig: 'JSON configuration',
      jsonHelp: 'Supports a complete mcpServers configuration or a server map. Existing MCP servers omitted from this import are preserved.', cancel: 'Cancel', importConnect: 'Import and connect',
      transportAria: 'Connection method', localStdio: 'Local stdio', remoteUrl: 'Remote URL',
      serverId: 'Server ID', command: 'Command',
      commandPlaceholder: 'npx -y @modelcontextprotocol/server-filesystem /path/to/folder',
      commandHelp: 'Full command line; quote arguments containing spaces. Not interpreted by a shell.',
      workingDirectory: 'Working directory', workingDirectoryPlaceholder: 'Optional, for example /path/to/project',
      environment: 'Environment', environmentHelp: 'One KEY=value entry per line; complete the variables required by this MCP.', url: 'MCP URL', headers: 'HTTP headers', headersHelp: 'One Header=value entry per line.',
      saveConnect: 'Save connection',
      required: 'This field is required.', invalidUrl: 'Enter a valid HTTP or HTTPS URL.', unbalancedQuote: 'Unclosed quote.',
      transportLabel: 'Transport', transportAuto: 'Auto fallback', transportStreamableHttp: 'Streamable HTTP', transportLegacySse: 'Legacy SSE',
      protocolLabel: 'Protocol preference', protocolLegacy: 'Legacy', protocolAuto: 'Auto-negotiate', protocolModern: '2026-07-28 only',
      protocolHelp: 'Existing configurations default to legacy; auto-negotiation selects an era from the server response.', sseProtocolHelp: 'Legacy SSE supports only the legacy protocol era.', expandAdvanced: 'Show advanced settings', collapseAdvanced: 'Hide advanced settings',
      stdioProtocolHelp: 'Auto-negotiate and “2026-07-28 only” first start a short-lived probe with the same command, arguments, working directory, and environment. The session process starts only after the probe exits. Existing configurations default to Legacy and start one process.',
    },
  },
} satisfies UiCatalog<McpCopy>;

export function getMcpCopy(locale: UiLocale): McpCopy {
  return MCP_COPY[locale];
}
